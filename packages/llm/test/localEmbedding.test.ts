import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalEmbedding, type ExtractorFactory } from '../src/localEmbedding.js';
import { REQUIRED_MODEL_FILES } from '@deepseek-ide/tools';

/**
 * 本地 embedding 装配层。
 *
 * 这一层存在的意义就是**降级路径**：语义检索是增强项，任何一步失败都必须
 * 返回 `client: null` 让检索回落到 BM25，绝不能抛错把 codebase_search 带崩。
 * `ExtractorFactory` 的注入点就是为这些用例准备的 —— 在这里我们不加载真实模型。
 */

/** 造一个文件齐备的假模型目录（只验证存在性，不校验内容）。 */
function makeModelDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-model-'));
  for (const file of REQUIRED_MODEL_FILES) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '{}');
  }
  return dir;
}

/** 成功的假工厂：把文本长度当向量，便于断言哪条文本走了哪条路径。 */
const okFactory: ExtractorFactory = async () => async (texts) => texts.map((t) => [t.length, 1, 2]);

describe('createLocalEmbedding', () => {
  it('disabled 时不加载模型，返回 null 客户端', async () => {
    const factory = vi.fn(okFactory);
    const handle = await createLocalEmbedding({ disabled: true }, factory);
    expect(handle.client).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(handle.describe).toMatch(/已关闭/);
  });

  it('来源不可用（本地目录缺失）时返回 null 客户端', async () => {
    const factory = vi.fn(okFactory);
    const handle = await createLocalEmbedding(
      { localDir: path.join(os.tmpdir(), 'echoly-does-not-exist-xyz') },
      factory,
    );
    expect(handle.client).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(handle.describe).toMatch(/不可用|不存在/);
  });

  it('工厂抛错时降级为 null 客户端，并说明加载失败', async () => {
    const failing: ExtractorFactory = async () => {
      throw new Error('onnx 加载失败');
    };
    const handle = await createLocalEmbedding({ localDir: makeModelDir() }, failing);
    expect(handle.client).toBeNull();
    expect(handle.describe).toMatch(/加载失败/);
    expect(handle.describe).toMatch(/onnx 加载失败/);
    expect(handle.source.kind).toBe('unavailable');
  });

  it('加载成功时返回可用客户端，且工厂收到解析出的来源', async () => {
    const dir = makeModelDir();
    const seen: string[] = [];
    const factory: ExtractorFactory = async (source) => {
      seen.push(source.kind);
      return async (texts) => texts.map((t) => [t.length]);
    };
    const handle = await createLocalEmbedding({ localDir: dir }, factory);
    expect(handle.client).not.toBeNull();
    expect(seen).toEqual(['local']);
    expect(handle.source).toEqual({ kind: 'local', dir });
    expect(handle.describe).toMatch(/本地目录/);
  });

  it('成功后客户端可真实产出向量', async () => {
    const handle = await createLocalEmbedding({ localDir: makeModelDir() }, okFactory);
    const vectors = await handle.client!.embedTexts(['ab', 'abcd']);
    expect(vectors).toEqual([
      [2, 1, 2],
      [4, 1, 2],
    ]);
  });

  it('按 modelId 走下载来源，且 onProgress 被转发给工厂', async () => {
    const progress = vi.fn();
    const factory: ExtractorFactory = async (source) => {
      expect(source).toEqual({ kind: 'download', modelId: 'some/model' });
      return async (texts) => texts.map(() => [1]);
    };
    const handle = await createLocalEmbedding(
      { modelId: 'some/model', onProgress: progress },
      factory,
    );
    expect(handle.client).not.toBeNull();
    expect(handle.describe).toMatch(/按需下载/);
  });

  it('batchSize 透传到客户端：超出批大小的唯一文本被分成多批', async () => {
    const batches: string[][] = [];
    const factory: ExtractorFactory = async () => async (texts) => {
      batches.push([...texts]);
      return texts.map(() => [1]);
    };
    const handle = await createLocalEmbedding({ localDir: makeModelDir(), batchSize: 2 }, factory);
    await handle.client!.embedTexts(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });
});
