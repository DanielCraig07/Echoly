import { describe, it, expect, vi } from 'vitest';
import { CompletionService, completionCacheKey } from '../src/main/completionService';

/**
 * 补全请求编排。
 *
 * 这三个能力都是为了省掉「白花的算力」，而且它们**失效时不会有任何报错** ——
 * 最多是慢一点、贵一点。所以每一条都得靠用例钉住：
 * 缓存命中、并发合并、以及「没人要了就真的中止」。
 */

const request = (
  overrides: Partial<{ prefix: string; suffix: string; language: string }> = {},
) => ({
  prefix: overrides.prefix ?? 'const a = ',
  suffix: overrides.suffix ?? ';\n',
  language: overrides.language ?? 'typescript',
});

/** 可控的假运行器：记录调用次数，并允许手动决定何时完成。 */
function makeRunner() {
  const calls: { request: unknown; signal: AbortSignal }[] = [];
  let release: ((value: string) => void) | null = null;
  const runner = vi.fn(async (_req: unknown, signal: AbortSignal) => {
    calls.push({ request: _req, signal });
    return await new Promise<string>((resolve, reject) => {
      release = resolve;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  return { calls, runner, release: (value: string) => release?.(value) };
}

describe('completionCacheKey', () => {
  it('同样的上下文得到同样的键', () => {
    expect(completionCacheKey(request())).toBe(completionCacheKey(request()));
  });

  it('前后缀或语言不同就是不同的键', () => {
    const base = completionCacheKey(request());
    expect(completionCacheKey(request({ prefix: 'const b = ' }))).not.toBe(base);
    expect(completionCacheKey(request({ suffix: ';\n\n' }))).not.toBe(base);
    expect(completionCacheKey(request({ language: 'python' }))).not.toBe(base);
  });

  it('窗口之外的内容不影响键（反正也不会进提示词）', () => {
    // 差异整个落在窗口之外：两个键应当相同
    const common = 'c'.repeat(2000);
    expect(
      completionCacheKey({ prefix: 'x'.repeat(1000) + common, suffix: '', language: 'ts' }),
    ).toBe(completionCacheKey({ prefix: 'y'.repeat(1000) + common, suffix: '', language: 'ts' }));
    // 差异落在窗口之内：两个键必须不同
    expect(completionCacheKey({ prefix: common + 'x', suffix: '', language: 'ts' })).not.toBe(
      completionCacheKey({ prefix: common + 'y', suffix: '', language: 'ts' }),
    );
  });

  it('键里不含原文', () => {
    const key = completionCacheKey({ prefix: 'SECRET_TOKEN_ABC', suffix: '', language: 'ts' });
    expect(key).not.toContain('SECRET_TOKEN_ABC');
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('CompletionService', () => {
  it('第二次相同请求直接命中缓存，不再问模型', async () => {
    const { runner, release } = makeRunner();
    const service = new CompletionService({ run: runner });

    const first = service.get(request(), 'a');
    release('return 1;');
    expect(await first).toEqual({ completion: 'return 1;', reused: false });

    const second = await service.get(request(), 'b');
    expect(second).toEqual({ completion: 'return 1;', reused: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('空补全也会被缓存：重复问一遍得到的还是空', async () => {
    const runner = vi.fn(async () => '');
    const service = new CompletionService({ run: runner });
    await service.get(request(), 'a');
    const again = await service.get(request(), 'b');
    expect(again).toEqual({ completion: '', reused: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('并发的相同请求合并成一次，双方都拿到结果', async () => {
    const { runner, release } = makeRunner();
    const service = new CompletionService({ run: runner });

    const a = service.get(request(), 'a');
    const b = service.get(request(), 'b');
    // 两边都在等同一个 promise，模型只被问了一次
    expect(runner).toHaveBeenCalledTimes(1);
    release('shared();');
    expect(await a).toEqual({ completion: 'shared();', reused: false });
    expect(await b).toEqual({ completion: 'shared();', reused: true });
    expect(service.inflightCount).toBe(0);
  });

  it('并发请求的上下文不同时不合并', async () => {
    const { runner, release } = makeRunner();
    const service = new CompletionService({ run: runner });
    void service.get(request({ prefix: 'aaa' }), 'a');
    void service.get(request({ prefix: 'bbb' }), 'b');
    expect(runner).toHaveBeenCalledTimes(2);
    release('x');
  });

  it('取消会中止底层请求', async () => {
    const { runner, calls } = makeRunner();
    const service = new CompletionService({ run: runner });
    const pending = service.get(request(), 'a');
    service.cancel('a');
    expect(calls[0].signal.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it('中止的请求不进缓存（它不是答案，只是被打断了）', async () => {
    const { runner } = makeRunner();
    const service = new CompletionService({ run: runner });
    const pending = service.get(request(), 'a');
    service.cancel('a');
    await expect(pending).rejects.toThrow();
    expect(service.cacheSize).toBe(0);
  });

  it('共享请求要所有调用方都取消才中止', async () => {
    const { runner, calls, release } = makeRunner();
    const service = new CompletionService({ run: runner });
    const a = service.get(request(), 'a');
    const b = service.get(request(), 'b');

    service.cancel('a');
    // b 还等着，不能因为 a 走了就把它一起掐掉
    expect(calls[0].signal.aborted).toBe(false);

    service.cancel('b');
    expect(calls[0].signal.aborted).toBe(true);
    release('never');
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
  });

  it('取消一个不存在的 id 不会抛错', () => {
    const service = new CompletionService({ run: vi.fn(async () => '') });
    expect(() => service.cancel('nope')).not.toThrow();
  });

  it('超过上限时淘汰最旧的条目', async () => {
    const service = new CompletionService({ run: async () => 'x', maxEntries: 2 });
    for (let i = 0; i < 4; i += 1) {
      await service.get(request({ prefix: `p${i}` }), `c${i}`);
    }
    expect(service.cacheSize).toBe(2);
    // p0/p1 已被淘汰 → 再问一次会真的重新运行
    const runner = vi.fn(async () => 'y');
    (service as unknown as { run: unknown }).run = runner;
    const revived = await service.get(request({ prefix: 'p0' }), 'again');
    expect(revived.reused).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('命中缓存的条目会被挪到队尾，避免刚用过的被淘汰', async () => {
    const service = new CompletionService({ run: async () => 'x', maxEntries: 2 });
    await service.get(request({ prefix: 'p0' }), 'a');
    await service.get(request({ prefix: 'p1' }), 'b');
    // 复用 p0，让它变成最新的
    await service.get(request({ prefix: 'p0' }), 'c');
    // 再写入 p2 → 应该淘汰 p1（最久未用），p0 留下
    await service.get(request({ prefix: 'p2' }), 'd');
    const p0 = await service.get(request({ prefix: 'p0' }), 'e');
    expect(p0.reused).toBe(true);
  });

  it('clearCache 之后要重新问模型', async () => {
    const runner = vi.fn(async () => 'x');
    const service = new CompletionService({ run: runner });
    await service.get(request(), 'a');
    service.clearCache();
    await service.get(request(), 'b');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('运行器抛错时把错误抛给调用方，且不污染缓存', async () => {
    const service = new CompletionService({
      run: async () => {
        throw new Error('网络断了');
      },
    });
    await expect(service.get(request(), 'a')).rejects.toThrow('网络断了');
    expect(service.cacheSize).toBe(0);
  });
});
