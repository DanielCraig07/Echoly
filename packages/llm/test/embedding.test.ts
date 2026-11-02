import { describe, expect, it, vi } from 'vitest';
import { EmbeddingClient, hashEmbeddingContent, type EmbeddingBackend } from '../src/embedding.js';

/** 用文本长度造一个可预测的向量，便于断言「哪个文本得到了哪个向量」。 */
const fakeVector = (text: string) => [text.length, text.charCodeAt(0) || 0];

const makeBackend = (): { backend: EmbeddingBackend; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    backend: {
      embed: async (texts) => {
        calls.push([...texts]);
        return texts.map(fakeVector);
      },
    },
  };
};

describe('hashEmbeddingContent', () => {
  it('同内容同指纹，不同内容不同指纹', () => {
    expect(hashEmbeddingContent('abc')).toBe(hashEmbeddingContent('abc'));
    expect(hashEmbeddingContent('abc')).not.toBe(hashEmbeddingContent('abd'));
  });
});

describe('EmbeddingClient', () => {
  it('返回顺序与入参严格一致', async () => {
    const { backend } = makeBackend();
    const client = new EmbeddingClient({ backend });
    const out = await client.embedTexts(['a', 'bb', 'ccc']);
    expect(out).toEqual([fakeVector('a'), fakeVector('bb'), fakeVector('ccc')]);
  });

  it('空输入不调用模型', async () => {
    const { backend, calls } = makeBackend();
    const client = new EmbeddingClient({ backend });
    expect(await client.embedTexts([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('同一批里的重复文本只送模型一次，但结果都回填', async () => {
    const { backend, calls } = makeBackend();
    const client = new EmbeddingClient({ backend });
    const out = await client.embedTexts(['dup', 'x', 'dup']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['dup', 'x']);
    expect(out[0]).toEqual(out[2]);
    expect(out[1]).toEqual(fakeVector('x'));
  });

  it('第二次调用同样内容时命中缓存，不再请求模型', async () => {
    const { backend, calls } = makeBackend();
    const client = new EmbeddingClient({ backend });
    await client.embedTexts(['same']);
    await client.embedTexts(['same']);
    expect(calls).toHaveLength(1);
  });

  it('按 batchSize 分批', async () => {
    const { backend, calls } = makeBackend();
    const client = new EmbeddingClient({ backend, batchSize: 2 });
    await client.embedTexts(['a', 'b', 'c', 'd', 'e']);
    expect(calls.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('缓存超过上限时淘汰最旧的', async () => {
    const { backend, calls } = makeBackend();
    const client = new EmbeddingClient({ backend, maxCacheEntries: 2 });
    await client.embedTexts(['a', 'b']);
    await client.embedTexts(['c']); // 挤掉 'a'
    await client.embedTexts(['a', 'b']);
    // 'a' 被淘汰需要重算，'b' 仍在缓存里
    expect(calls.at(-1)).toEqual(['a']);
  });

  it('命中缓存会刷新其新鲜度（近似 LRU）', async () => {
    const { backend, calls } = makeBackend();
    const client = new EmbeddingClient({ backend, maxCacheEntries: 2 });
    await client.embedTexts(['a', 'b']);
    await client.embedTexts(['a']); // 命中 a，使其变成最新
    await client.embedTexts(['c']); // 淘汰的应是 b
    await client.embedTexts(['b']);
    expect(calls.at(-1)).toEqual(['b']);
  });

  it('首次调用确立维度，之后不一致直接报错', async () => {
    const embed = vi
      .fn()
      .mockResolvedValueOnce([[1, 2]])
      .mockResolvedValueOnce([[1, 2, 3]]);
    const client = new EmbeddingClient({ backend: { embed } });
    await client.embedTexts(['a']);
    expect(client.vectorDimension).toBe(2);
    await expect(client.embedTexts(['b'])).rejects.toThrow(/维度不一致/);
  });

  it('模型返回条数不符时报错，而不是错位回填', async () => {
    const embed = vi.fn().mockResolvedValue([[1, 2]]);
    const client = new EmbeddingClient({ backend: { embed } });
    await expect(client.embedTexts(['a', 'b'])).rejects.toThrow(/条数不符/);
  });

  it('模型返回空向量时报错', async () => {
    const embed = vi.fn().mockResolvedValue([[]]);
    const client = new EmbeddingClient({ backend: { embed } });
    await expect(client.embedTexts(['a'])).rejects.toThrow(/空向量/);
  });
});
