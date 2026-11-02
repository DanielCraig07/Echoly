/**
 * 行内补全的请求编排：内容缓存 + 并发合并 + 取消传播。
 *
 * 三个问题，三种代价：
 *
 * 1. **重复请求。** 补全的触发条件是「停手 350ms」，而实际编辑里大量动作是
 *    退格又打回来、光标来回挪两下、撤销再重做 —— 上下文一模一样，却每次都重新问模型。
 *    按内容缓存直接省掉这一整类开销。
 * 2. **并发重复。** 两次请求真的同时发出时（多编辑器同开一份文件、快速来回切），
 *    该合并成一次；否则同样的 prompt 会被算两遍。
 * 3. **没人要的结果。** 用户继续打字后，上一轮的请求还在跑，跑完的结果直接丢掉。
 *    这不只是浪费 token —— 它占着并发闸门，会让**真正需要**的那次请求排队等它。
 *
 * 缓存键的取舍：只用「光标前后的代码 + 语言」，**不含最近编辑**。
 * 最近编辑是意图提示而不是答案的决定因素；把它并进键里，会让「退格再打回来」
 * 这种最常见的命中场景全部落空，缓存也就没有意义了。
 */

import { createHash } from 'node:crypto';

/** 与提示词里截取的窗口保持一致：只有这段内容会影响模型输出。 */
const WINDOW_PREFIX_CHARS = 2000;
const WINDOW_SUFFIX_CHARS = 1000;

/** 缓存条目上限。补全结果都是几十到几百字符，留多一点比频繁淘汰划算。 */
export const DEFAULT_COMPLETION_CACHE_ENTRIES = 128;

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  language?: string;
  recentEdits?: { inserted: string; deleted: string }[];
}

export type CompletionRunner = (request: CompletionRequest, signal: AbortSignal) => Promise<string>;

/**
 * 内容键。
 *
 * 走 sha1 而不是把原文拼成键：键里包含最多 3000 字符的代码，
 * 直接当 Map 键会把这些代码整段留在内存里（还有可能出现在堆快照中）。
 * 摘要是定长且不含内容本身。
 */
export function completionCacheKey(request: CompletionRequest): string {
  const prefix = request.prefix.slice(-WINDOW_PREFIX_CHARS);
  const suffix = request.suffix.slice(0, WINDOW_SUFFIX_CHARS);
  const language = request.language ?? '';
  return createHash('sha1').update(`${language}\u0000${prefix}\u0000${suffix}`).digest('hex');
}

interface InflightEntry {
  key: string;
  promise: Promise<string>;
  controller: AbortController;
  /** 还等着这次结果的调用方数量。归零才真正中止请求。 */
  callers: number;
}

export interface CompletionLookup {
  completion: string;
  /** 结果来自缓存，或与同一时刻的重复请求合并 —— 都没有真的再问一次模型 */
  reused: boolean;
}

export class CompletionService {
  private readonly cache = new Map<string, string>();
  private readonly inflight = new Map<string, InflightEntry>();
  /** 调用方 id → 它正在等的那次请求，取消时用 */
  private readonly callers = new Map<string, InflightEntry>();
  private readonly maxEntries: number;
  private readonly run: CompletionRunner;

  constructor(options: { run: CompletionRunner; maxEntries?: number }) {
    this.run = options.run;
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_COMPLETION_CACHE_ENTRIES);
  }

  /**
   * 取一次补全。
   *
   * `callerId` 用于取消：同一次请求被多方共享（缓存合并）时，
   * 只有**所有**挂在上面的调用方都取消了，才真的中止 —— 否则一个人切走光标
   * 会把另一个人正等着的结果一起掐掉。
   */
  async get(request: CompletionRequest, callerId: string): Promise<CompletionLookup> {
    const key = completionCacheKey(request);

    const hit = this.cache.get(key);
    if (hit !== undefined) {
      // 命中后挪到队尾，让淘汰更接近 LRU
      this.cache.delete(key);
      this.cache.set(key, hit);
      return { completion: hit, reused: true };
    }

    const existing = this.inflight.get(key);
    if (existing) {
      existing.callers += 1;
      this.callers.set(callerId, existing);
      try {
        return { completion: await existing.promise, reused: true };
      } finally {
        this.callers.delete(callerId);
      }
    }

    const controller = new AbortController();
    const entry: InflightEntry = {
      key,
      controller,
      callers: 1,
      promise: Promise.resolve(''),
    };
    const promise = this.run(request, controller.signal)
      .then((completion) => {
        this.remember(key, completion);
        return completion;
      })
      .finally(() => {
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      });
    entry.promise = promise;
    this.inflight.set(key, entry);
    this.callers.set(callerId, entry);
    // 所有调用方都取消时可能没人 await 这个 promise，挂一个空的 catch
    // 避免 Node 把它算成 unhandled rejection（那会直接把进程搞挂）。
    promise.catch(() => undefined);

    try {
      return { completion: await promise, reused: false };
    } finally {
      this.callers.delete(callerId);
    }
  }

  /** 调用方不再需要结果（用户又敲了一下、切走了）。 */
  cancel(callerId: string): void {
    const entry = this.callers.get(callerId);
    if (!entry) return;
    this.callers.delete(callerId);
    entry.callers -= 1;
    if (entry.callers <= 0) entry.controller.abort();
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** 缓存条目数，供测试与排查使用。 */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 正在跑的请求数。 */
  get inflightCount(): number {
    return this.inflight.size;
  }

  private remember(key: string, completion: string): void {
    this.cache.set(key, completion);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
