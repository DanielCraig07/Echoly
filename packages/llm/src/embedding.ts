/**
 * 本地 embedding 客户端。
 *
 * 只负责「把文本变成向量」这件事的**编排**：内容去重、按批送模型、结果缓存、维度校验。
 * 真正调用 onnx 模型的部分通过 `EmbeddingBackend` 注入，因此这一层的逻辑可以脱离
 * 25MB 的模型文件被测试覆盖 —— 而这里最容易错的恰恰是缓存与去重，不是模型本身。
 */

import { createHash } from 'node:crypto';

/** 真实的模型调用。返回的数组必须与输入等长、每个向量维度一致。 */
export interface EmbeddingBackend {
  embed: (texts: string[]) => Promise<number[][]>;
}

export interface EmbeddingClientOptions {
  backend: EmbeddingBackend;
  /** 单次送入模型的文本条数上限。批太大会显著抬高单次延迟峰值。 */
  batchSize?: number;
  /** 缓存条目上限，超出后按插入顺序淘汰最旧的 */
  maxCacheEntries?: number;
}

export const DEFAULT_EMBEDDING_BATCH_SIZE = 16;
export const DEFAULT_EMBEDDING_CACHE_ENTRIES = 20_000;

/**
 * 内容指纹。
 *
 * 用内容哈希而不是「文件路径 + mtime」做缓存键：同一个块在文件里挪了位置、
 * 或者文件被重新保存但内容没变，都不该触发重新计算向量 —— 而仅靠 mtime 判断会。
 */
export function hashEmbeddingContent(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

export class EmbeddingClient {
  private readonly cache = new Map<string, number[]>();
  private readonly backend: EmbeddingBackend;
  private readonly batchSize: number;
  private readonly maxCacheEntries: number;
  private dimension = 0;

  constructor(options: EmbeddingClientOptions) {
    this.backend = options.backend;
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE);
    this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? DEFAULT_EMBEDDING_CACHE_ENTRIES);
  }

  /** 已确定的向量维度；尚未算过任何向量时为 0。 */
  get vectorDimension(): number {
    return this.dimension;
  }

  /**
   * 批量向量化，返回顺序与入参严格一致。
   *
   * 两处去重：命中缓存的直接返回；同一批里的重复文本只送模型一次。
   * 索引场景里重复内容很常见（两个文件里出现同一段样板代码），
   * 不去重的话模型调用量会随代码重复度上升。
   */
  async embedTexts(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    // 同一批内的重复文本只算一次：key 是内容指纹，value 是需要回填的下标
    const pending = new Map<string, { text: string; indexes: number[] }>();

    texts.forEach((text, index) => {
      const key = hashEmbeddingContent(text);
      const cached = this.cache.get(key);
      if (cached) {
        // 缓存命中时也把它挪到队尾，让淘汰策略更接近 LRU
        this.cache.delete(key);
        this.cache.set(key, cached);
        results[index] = cached;
        return;
      }
      const entry = pending.get(key);
      if (entry) entry.indexes.push(index);
      else pending.set(key, { text, indexes: [index] });
    });

    const entries = Array.from(pending.entries());
    for (let start = 0; start < entries.length; start += this.batchSize) {
      const slice = entries.slice(start, start + this.batchSize);
      const vectors = await this.backend.embed(slice.map(([, entry]) => entry.text));
      this.assertShape(slice.length, vectors);

      slice.forEach(([key, entry], i) => {
        const vector = vectors[i];
        this.assertDimension(vector);
        this.remember(key, vector);
        entry.indexes.forEach((index) => {
          results[index] = vector;
        });
      });
    }

    return results.map((vector) => vector as number[]);
  }

  clearCache(): void {
    this.cache.clear();
  }

  private assertShape(expected: number, vectors: number[][]): void {
    if (vectors.length !== expected) {
      throw new Error(`embedding 返回条数不符：期望 ${expected}，实际 ${vectors.length}`);
    }
  }

  /**
   * 维度一致性校验。
   *
   * 首次调用确立维度，之后每一批都必须与它相同。混用不同模型的向量、或模型文件损坏，
   * 都会在这里被拦住 —— 否则所有块的相似度会变得一样，排序退化成文件顺序，
   * 表现为「搜索在工作但结果全无关」，且没有任何报错可查。
   */
  private assertDimension(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('embedding 返回了空向量');
    }
    if (this.dimension === 0) {
      this.dimension = vector.length;
      return;
    }
    if (vector.length !== this.dimension) {
      throw new Error(
        `embedding 维度不一致：已有 ${this.dimension}，本批 ${vector.length}（可能加载了不同的模型）`,
      );
    }
  }

  private remember(key: string, vector: number[]): void {
    this.cache.set(key, vector);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
