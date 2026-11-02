import { describe, expect, it } from 'vitest';
import { DEFAULT_EMBEDDING_PROBE_MODELS, probeEmbedding } from '../src/index.js';

/**
 * embedding 端点探测。
 *
 * 重点不在「连得上」，而在**把失败说清楚**：内网网关的表现是对话可用、
 * `/v1/embeddings` 一律 503。这跟「模型名写错了」的处置方式完全不同，
 * 所以探测结果必须带上「试过哪些模型、各自为什么失败」。
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('probeEmbedding', () => {
  it('第一个候选模型可用时立即返回维度', async () => {
    const calls: string[] = [];
    const result = await probeEmbedding({
      baseUrl: 'http://gw:1333',
      candidateModels: ['m1', 'm2'],
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push(url);
        const sent = JSON.parse(String(init.body)) as { model: string };
        expect(sent.model).toBe('m1');
        return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('m1');
    expect(result.dimension).toBe(3);
    expect(calls).toHaveLength(1);
  });

  it('所有候选都 503 时报出每一个的失败原因', async () => {
    const result = await probeEmbedding({
      baseUrl: 'http://gw:1333',
      candidateModels: ['a', 'b'],
      fetchImpl: (async () =>
        jsonResponse({ error: 'No available channel' }, 503)) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map((a) => a.model)).toEqual(['a', 'b']);
    expect(result.attempts[0].error).toMatch(/503|No available channel/);
    expect(result.detail).toContain('a, b');
  });

  it('200 但响应里没有向量时算失败，并继续试下一个', async () => {
    // 网关把请求转成了空壳响应：比 503 更隐蔽，绝不能当成成功，
    // 否则上层会「成功地」拿到一堆 undefined。
    const result = await probeEmbedding({
      baseUrl: 'http://gw:1333',
      candidateModels: ['empty', 'good'],
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(String(init.body)) as { model: string };
        if (sent.model === 'empty') return jsonResponse({ data: [] });
        return jsonResponse({ data: [{ embedding: [1, 2] }] });
      }) as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('good');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].error).toMatch(/没有向量/);
  });

  it('指定 model 时只试这一个', async () => {
    let calls = 0;
    await probeEmbedding({
      baseUrl: 'http://gw:1333',
      model: 'only-this',
      candidateModels: ['x', 'y'],
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    expect(calls).toBe(1);
  });

  it('baseUrl 已经带 /v1 时不会拼成 /v1/v1/embeddings', async () => {
    const urls: string[] = [];
    await probeEmbedding({
      baseUrl: 'http://gw:1333/v1',
      model: 'm',
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return jsonResponse({ data: [{ embedding: [1] }] });
      }) as unknown as typeof fetch,
    });
    expect(urls).toEqual(['http://gw:1333/v1/embeddings']);
  });

  it('网络异常（fetch 抛错）被记进 attempts 而不是抛出去', async () => {
    const result = await probeEmbedding({
      baseUrl: 'http://gw:1333',
      candidateModels: ['m'],
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts[0].error).toContain('ECONNREFUSED');
  });

  it('默认候选表非空且包含常见模型名', () => {
    expect(DEFAULT_EMBEDDING_PROBE_MODELS.length).toBeGreaterThan(0);
    expect(DEFAULT_EMBEDDING_PROBE_MODELS).toContain('text-embedding-3-small');
  });
});
