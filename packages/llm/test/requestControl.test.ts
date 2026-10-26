import { describe, expect, it, vi } from 'vitest';
import { LlmClient } from '../src/index';
import { Semaphore, isRetryableNetworkError, retryDelayMs, withRetry } from '../src/requestControl';

/** 造一个 SSE 响应，用于让 chatStream 走完正常路径。 */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const DONE_CHUNKS = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

describe('Semaphore', () => {
  it('limits concurrent holders and releases to the next waiter in order', async () => {
    const gate = new Semaphore(1);
    const order: number[] = [];
    const release1 = await gate.acquire();

    const second = gate.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const third = gate.acquire().then((release) => {
      order.push(3);
      return release;
    });
    expect(gate.pending).toBe(2);

    release1();
    const release2 = await second;
    expect(order).toEqual([2]);

    release2();
    const release3 = await third;
    expect(order).toEqual([2, 3]);
    release3();
    expect(gate.pending).toBe(0);
  });

  it('never over-releases when the same holder calls release twice', async () => {
    const gate = new Semaphore(2);
    const release1 = await gate.acquire();
    const release2 = await gate.acquire();
    release1();
    release1(); // 语义上是 bug，但不应把名额涨到 3 —— 这里只验证流程不崩且后续仍可获取
    release2();
    const release3 = await gate.acquire();
    release3();
    expect(gate.pending).toBe(0);
  });
});

describe('withRetry', () => {
  it('retries on retryable status and returns the eventual success', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls++;
        return new Response(null, { status: calls < 3 ? 503 : 200 });
      },
      (r, err) => (err ? true : !!r && r.status === 503),
      { maxAttempts: 3 },
    );
    expect(calls).toBe(3);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.status).toBe(200);
  });

  it('gives up when shouldRetry says no, without extra calls', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls++;
        return new Response(null, { status: 400 });
      },
      (r) => !!r && r.status === 503,
      { maxAttempts: 3 },
    );
    expect(calls).toBe(1);
    expect(res.ok).toBe(true);
  });

  it('exhausts retries and hands back the last error', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls++;
        throw new Error('fetch failed');
      },
      () => true,
      { maxAttempts: 2 },
    );
    expect(calls).toBe(3);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.cancelled).toBe(false);
      expect((res.lastError as Error).message).toBe('fetch failed');
    }
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const res = await withRetry(
      async () => {
        calls++;
        throw new Error('fetch failed');
      },
      () => true,
      { maxAttempts: 3, signal: controller.signal },
    );
    expect(calls).toBe(1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.cancelled).toBe(true);
  });
});

describe('retry predicates', () => {
  it('does not treat an abort as a retryable network error', () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    expect(isRetryableNetworkError(err)).toBe(false);
  });

  it('treats econnrefused as retryable', () => {
    expect(isRetryableNetworkError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:80'))).toBe(
      true,
    );
  });

  it('backs off with jitter that never exceeds the cap', () => {
    for (let i = 0; i < 20; i++) {
      const d = retryDelayMs(10);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });
});

describe('LlmClient retry integration', () => {
  it('re-sends after a 503 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response('gateway down', { status: 503 });
      return sseResponse(DONE_CHUNKS);
    }) as unknown as typeof fetch;

    const client = new LlmClient({ baseUrl: 'http://x', fetchImpl, maxRetries: 1, maxConcurrency: 4 });
    const result = await client.chatStreamCollect({ messages: [{ role: 'user', content: 'hi' }] });
    expect(calls).toBe(2);
    expect(result.message.content).toBe('hi');
  });

  it('does not retry a 400 (parameter error)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response('bad request: model not found', { status: 400 });
    }) as unknown as typeof fetch;

    const client = new LlmClient({ baseUrl: 'http://x', fetchImpl, maxRetries: 2, maxConcurrency: 4 });
    await expect(
      // 400 且报错文本不指向任何可降级字段 -> 不重试、不降级，直接抛出
      client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('releases the concurrency slot even when the request fails', async () => {
    const gate = new Semaphore(1);
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const client = new LlmClient({
      baseUrl: 'http://x',
      fetchImpl,
      maxRetries: 0,
      maxConcurrency: 1,
    });
    // 通过 withOptions 换不回 gate 实例，这里直接验证「失败后仍能再次发起请求」：
    // 若名额泄漏，第二次调用会永远挂住，这个测试就会超时。
    await expect(client.chat({ messages: [{ role: 'user', content: 'a' }] })).rejects.toThrow();
    await expect(client.chat({ messages: [{ role: 'user', content: 'b' }] })).rejects.toThrow();
  });

  it('honours a custom concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return sseResponse(DONE_CHUNKS);
    }) as unknown as typeof fetch;

    const client = new LlmClient({ baseUrl: 'http://x', fetchImpl, maxConcurrency: 2 });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        client.chatStreamCollect({ messages: [{ role: 'user', content: 'hi' }] }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('releases the slot when a consumer abandons the stream early', async () => {
    const fetchImpl = (async () => sseResponse(DONE_CHUNKS)) as unknown as typeof fetch;
    const client = new LlmClient({ baseUrl: 'http://x', fetchImpl, maxConcurrency: 1 });

    // 只取第一块就走人：必须触发生成器的 return() 从而释放名额，
    // 否则下一个请求会永久排队（此处会超时）。
    const gen = client.chatStream({ messages: [{ role: 'user', content: 'hi' }] });
    await gen.next();
    await gen.return(undefined as never);

    vi.useRealTimers();
    const result = await client.chatStreamCollect({ messages: [{ role: 'user', content: 'again' }] });
    expect(result.message.content).toBe('hi');
  });
});
