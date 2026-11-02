/**
 * 本地 embedding 模型的来源解析。
 *
 * 内网网关没有 embedding 通道（实测 `/v1/models` 只有 5 个对话模型、`/v1/embeddings`
 * 对常见模型名一律 503），所以语义检索必须用本地模型。而本地模型要同时支持两条路：
 *
 * 1. **手动放置**：把 onnx 模型文件放到指定目录（企业网络常无法直连 HuggingFace，
 *    或首次下载等待时间不可接受）。这条路优先。
 * 2. **按需下载**：本地没有则走 transformers 的远端加载，下载后缓存。
 *
 * 两条都不通时返回 `unavailable`，由上层回落到 BM25 —— 语义检索是增强项，
 * 缺了它检索仍然可用，只是退化成词法匹配。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 一个可用的 transformers 模型目录必须齐备的文件。
 *
 * 只检查存在性、不检查内容：真正加载时库自己会校验格式，这里多做一步只会
 * 把「文件损坏」误报成「文件缺失」，反而误导排查方向。
 */
export const REQUIRED_MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
] as const;

export interface EmbeddingSourceOptions {
  /** 本地模型目录，优先级最高 */
  localDir?: string | null;
  /** 远端模型 id，本地不可用时尝试下载 */
  modelId?: string | null;
}

export type EmbeddingSource =
  | { kind: 'local'; dir: string }
  | { kind: 'download'; modelId: string }
  | { kind: 'unavailable'; reason: string };

export const DEFAULT_EMBEDDING_MODEL_ID = 'Xenova/bge-small-zh-v1.5';

/**
 * 从环境变量读取来源配置。
 *
 * 除了方便调试，`ECHOLY_EMBEDDING_DISABLED` 还有一个实际用途：
 * 语义索引在首次建库时会有可感知的耗时，出问题时需要一个不改代码就能整体关掉的开关。
 */
export function readEmbeddingEnv(env: NodeJS.ProcessEnv = process.env): {
  options: EmbeddingSourceOptions;
  disabled: boolean;
} {
  return {
    disabled: env.ECHOLY_EMBEDDING_DISABLED === '1',
    options: {
      localDir: env.ECHOLY_EMBEDDING_MODEL_DIR ?? null,
      modelId: env.ECHOLY_EMBEDDING_MODEL_ID ?? null,
    },
  };
}

/** 目录是否齐备。缺哪个文件会被列出来 —— 「为什么回落到 BM25 了」需要能一眼答上。 */
export function inspectModelDir(dir: string): { ok: boolean; missing: string[] } {
  const missing = REQUIRED_MODEL_FILES.filter((file) => !fs.existsSync(path.join(dir, file)));
  return { ok: missing.length === 0, missing };
}

/**
 * 决定用哪条路。
 *
 * 注意「本地目录存在但不完整」时**不静默跳过**：这种情况几乎都是放错版本或漏拷文件，
 * 而静默改成下载会让人以为本地放置失败得莫名其妙。所以把它作为不可用理由报出去。
 */
export function resolveEmbeddingSource(options: EmbeddingSourceOptions = {}): EmbeddingSource {
  const localDir = options.localDir?.trim();

  if (localDir) {
    if (!fs.existsSync(localDir)) {
      return { kind: 'unavailable', reason: `本地模型目录不存在：${localDir}` };
    }
    const { ok, missing } = inspectModelDir(localDir);
    if (!ok) {
      return { kind: 'unavailable', reason: `本地模型目录缺少文件：${missing.join(', ')}` };
    }
    return { kind: 'local', dir: localDir };
  }

  const modelId = options.modelId?.trim() || DEFAULT_EMBEDDING_MODEL_ID;
  return { kind: 'download', modelId };
}

/** 人可读的来源描述，用于日志与「当前生效配置」展示。 */
export function describeEmbeddingSource(source: EmbeddingSource): string {
  switch (source.kind) {
    case 'local':
      return `本地目录 ${source.dir}`;
    case 'download':
      return `按需下载 ${source.modelId}`;
    default:
      return `不可用（${source.reason}），语义检索回落到 BM25`;
  }
}
