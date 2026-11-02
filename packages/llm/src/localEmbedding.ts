/**
 * 本地 embedding 的装配层：把来源解析（本地目录 / 按需下载）与 embedding 客户端接起来。
 *
 * 模型加载通过 `ExtractorFactory` 注入，好处有两个：
 * 1. 降级路径（未启用 / 来源不可用 / 加载失败）可以脱离真实模型被测试覆盖；
 * 2. 真正加载 15MB 依赖与 25MB 权重只发生在**确实要用**的时候，光是 import
 *    这个模块不会把 onnxruntime 拖起来 —— 应用启动不该为一项可能用不到的增强能力买单。
 */

import {
  describeEmbeddingSource,
  resolveEmbeddingSource,
  type EmbeddingSource,
} from '@deepseek-ide/tools';
import {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  EmbeddingClient,
  type EmbeddingBackend,
} from './embedding.js';

/** 把文本列表转成向量列表。真实实现由 transformers 提供。 */
export type ExtractorFactory = (
  source: EmbeddingSource,
  onProgress?: (message: string) => void,
) => Promise<(texts: string[]) => Promise<number[][]>>;

export interface LocalEmbeddingOptions {
  /** 本地模型目录，优先使用 */
  localDir?: string | null;
  /** 远端模型 id，本地不可用时按需下载 */
  modelId?: string | null;
  /** 显式关闭（对应 ECHOLY_EMBEDDING_DISABLED） */
  disabled?: boolean;
  batchSize?: number;
  onProgress?: (message: string) => void;
}

export interface LocalEmbeddingHandle {
  source: EmbeddingSource;
  /** 不可用时为 null，调用方据此回落到 BM25 */
  client: EmbeddingClient | null;
  /** 人可读的来源描述，用于日志与「当前生效配置」展示 */
  describe: string;
}

/**
 * 默认的模型加载实现：本地目录直接用，否则交给 transformers 按 id 下载并缓存。
 *
 * 用动态 import：静态 import 会让任何引用本模块的代码都被迫加载 onnxruntime。
 */
const defaultFactory: ExtractorFactory = async (source, onProgress) => {
  // 调用方已在上游拦掉 unavailable，但类型收窄不会跨函数边界生效，
  // 这里显式挡一层，后面的 source 才能收窄到 local | download。
  if (source.kind === 'unavailable') {
    throw new Error(source.reason);
  }

  const { pipeline, env } = await import('@huggingface/transformers');

  // 只允许访问本地文件时，可以让 transformers 完全不联网 —— 对应「手工放置模型」那条路。
  if (source.kind === 'local') {
    env.allowRemoteModels = false;
    env.localModelPath = source.dir;
  } else if (source.kind === 'download') {
    onProgress?.(`首次使用需下载模型 ${source.modelId}（约 25MB），完成前语义检索不可用`);
  }

  const model = source.kind === 'local' ? source.dir : source.modelId;
  const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });

  return async (texts: string[]) => {
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    // transformers 返回的是带 tolist() 的张量对象
    return (output as { tolist: () => number[][] }).tolist();
  };
};

/**
 * 装配本地 embedding。
 *
 * 任何一步失败都返回 `client: null` 而不是抛错 —— 语义检索是增强项，
 * 它不可用时检索应当静默回落到现有 BM25，而不是让 codebase_search 整个不可用。
 * 但失败原因会进日志与 describe，避免「为什么搜得不准」无从查起。
 */
export async function createLocalEmbedding(
  options: LocalEmbeddingOptions = {},
  factory: ExtractorFactory = defaultFactory,
): Promise<LocalEmbeddingHandle> {
  if (options.disabled) {
    return {
      source: { kind: 'unavailable', reason: '已通过 ECHOLY_EMBEDDING_DISABLED 关闭' },
      client: null,
      describe: '语义检索已关闭，使用 BM25 词法检索',
    };
  }

  const source = resolveEmbeddingSource({
    localDir: options.localDir,
    modelId: options.modelId,
  });

  if (source.kind === 'unavailable') {
    return {
      source,
      client: null,
      describe: describeEmbeddingSource(source),
    };
  }

  try {
    const extract = await factory(source, options.onProgress);
    const backend: EmbeddingBackend = { embed: (texts) => extract(texts) };
    return {
      source,
      client: new EmbeddingClient({
        backend,
        batchSize: options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
      }),
      describe: describeEmbeddingSource(source),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      source: { kind: 'unavailable', reason },
      client: null,
      describe: `模型加载失败（${reason}），语义检索回落到 BM25`,
    };
  }
}
