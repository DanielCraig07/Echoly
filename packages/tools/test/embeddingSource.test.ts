import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_EMBEDDING_MODEL_ID,
  REQUIRED_MODEL_FILES,
  describeEmbeddingSource,
  inspectModelDir,
  readEmbeddingEnv,
  resolveEmbeddingSource,
} from '../src/embeddingSource.js';

describe('resolveEmbeddingSource', () => {
  let dir = '';

  const writeModel = (target: string, files: readonly string[] = REQUIRED_MODEL_FILES) => {
    for (const file of files) {
      const abs = path.join(target, file);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '{}');
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-embed-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('本地目录齐备时优先用本地，不下载', () => {
    const modelDir = path.join(dir, 'model');
    writeModel(modelDir);
    const source = resolveEmbeddingSource({ localDir: modelDir, modelId: 'x/y' });
    expect(source).toEqual({ kind: 'local', dir: modelDir });
  });

  it('没有本地目录时走下载，且使用默认模型 id', () => {
    expect(resolveEmbeddingSource({})).toEqual({
      kind: 'download',
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
    });
    expect(resolveEmbeddingSource({ modelId: '  ' })).toEqual({
      kind: 'download',
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
    });
  });

  it('目录存在但不完整时明确报不可用，不静默改成下载', () => {
    // 静默改成下载会让人以为「本地放置失败得莫名其妙」，所以要把缺哪些文件说出来
    const modelDir = path.join(dir, 'partial');
    writeModel(modelDir, ['config.json']);
    const source = resolveEmbeddingSource({ localDir: modelDir, modelId: 'x/y' });
    expect(source.kind).toBe('unavailable');
    if (source.kind === 'unavailable') {
      expect(source.reason).toContain('tokenizer.json');
      expect(source.reason).toContain('onnx/model_quantized.onnx');
    }
  });

  it('目录不存在时报不可用并带上路径', () => {
    const source = resolveEmbeddingSource({ localDir: path.join(dir, 'nope') });
    expect(source.kind).toBe('unavailable');
    if (source.kind === 'unavailable') expect(source.reason).toContain('nope');
  });
});

describe('inspectModelDir', () => {
  it('列出缺失的文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echoly-embed-'));
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), '{}');
      const { ok, missing } = inspectModelDir(dir);
      expect(ok).toBe(false);
      expect(missing).toHaveLength(REQUIRED_MODEL_FILES.length - 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readEmbeddingEnv', () => {
  it('读取目录与模型 id 覆盖', () => {
    const { options, disabled } = readEmbeddingEnv({
      ECHOLY_EMBEDDING_MODEL_DIR: '/tmp/m',
      ECHOLY_EMBEDDING_MODEL_ID: 'a/b',
    } as NodeJS.ProcessEnv);
    expect(options).toEqual({ localDir: '/tmp/m', modelId: 'a/b' });
    expect(disabled).toBe(false);
  });

  it('ECHOLY_EMBEDDING_DISABLED=1 时标记为关闭', () => {
    expect(readEmbeddingEnv({ ECHOLY_EMBEDDING_DISABLED: '1' } as NodeJS.ProcessEnv).disabled).toBe(
      true,
    );
  });
});

describe('describeEmbeddingSource', () => {
  it('三种来源都给出人可读描述', () => {
    expect(describeEmbeddingSource({ kind: 'local', dir: '/m' })).toContain('/m');
    expect(describeEmbeddingSource({ kind: 'download', modelId: 'a/b' })).toContain('a/b');
    expect(describeEmbeddingSource({ kind: 'unavailable', reason: '少文件' })).toContain('回落');
  });
});
