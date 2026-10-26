/**
 * LLM 请求的重试与并发控制。
 *
 * 分开讲两件事，因为它们的失效模式完全不同：
 *
 * **重试**针对的是「请求还没建立起来就失败了」——连接被拒、网关 502/503/504、
 * 限流 429。这些情况下模型什么都没有生成，重发一个字节级等价的请求是安全的。
 * 与之相对，**流已经开始吐内容之后再失败是不能重试的**：上层已经拿到了半截
 * 回答并渲染给用户，重发只会得到两份互相矛盾的结果。所以重试只包住
 * 「拿到响应头」这一步（见 LlmClient.postChat），body 一旦开始读就交给流内部的
 * 看门狗与复读熔断处理。
 *
 * **并发闸门**针对的是内网单节点推理服务：多窗口、快捷动作（补全/探测/内联 AI）
 * 与 Agent 主循环会同时发起请求，把网关的排队深度顶穿之后表现为首 token 超时——
 * 也就是用户看到的「模型卡住了」。这里给在途请求数加一个上限，多余的排队等，
 * 而不是一起去挤推理节点。
 *
 * 闸门的嵌套风险：一个已在闸门内的请求若又发起另一个需要闸门的请求，且并发上限
 * 小于嵌套层数，就会自我死锁。默认值取得足够宽（4）以容纳「Agent 主循环 +
 * 后台探测 + 内联补全」这种真实组合，同时把并发限制在个位数。
 */

const MAX_RETRY_ATTEMPTS = 2;
/** 退避基数：第一次重试等 500ms，第二次 1000ms（再叠加抖动）。 */
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
/**
 * 只重试那些「确定没生成内容」的状态码。
 * 400/401/403/404 重发多少次结果都一样，重试只会把一次快速失败拖成三次。
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, Math.floor(limit));
  }

  /** 取得一个名额；返回释放函数。调用方必须在 finally 里调用它。 */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    // 被唤醒时名额已由 release 直接转会过来，不能再减一次
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }

  /** 仅用于测试与状态展示。 */
  get pending(): number {
    return this.queue.length;
  }
}

/** 进程级默认闸门。单独暴露出来，方便宿主按推理节点容量整体调整。 */
export const defaultRequestGate = new Semaphore(4);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** 服务端允许我们等的最长时间：真按一个离谱的 `Retry-After` 睡下去，界面会觉得卡死。 */
const MAX_SERVER_HINTED_DELAY_MS = 30_000;

/**
 * 解析 429/503 上的 `Retry-After`。
 *
 * 两种合法格式：秒数（`Retry-After: 5`）与 HTTP 日期（`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`）。
 * 网关上还见过直接给毫秒的（值大得离谱），所以超过一个阈值时按毫秒理解 ——
 * 一个将该等 60 秒的响应被读成 60 毫秒，会让重试全部撞在同一秒里。
 *
 * 返回 null 表示响应里没有可用的提示，调用方回退到指数退避。
 */
export function retryAfterMs(res: Response | undefined): number | null {
  if (!res || typeof res.headers?.get !== 'function') return null;
  const raw = res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset');
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 纯数字：秒（> 1000 时按毫秒理解，见上）
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1000 ? n : n * 1000;
    return Math.min(Math.round(ms), MAX_SERVER_HINTED_DELAY_MS);
  }

  // HTTP 日期
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const delta = at - Date.now();
  if (delta <= 0) return null;
  return Math.min(Math.round(delta), MAX_SERVER_HINTED_DELAY_MS);
}

/**
 * 丢弃一个不打算再读的响应体。
 *
 * 不读也不 cancel 的话，Node 的 undici 会一直持有这个连接，直到 GC 才回收 ——
 * 重试几次之后连接池就被这些「死响应」占满了，表现是后续请求**没发出就超时**。
 * 之前的实现正是这样：`withRetry` 拿到 429 就丢掉 resp 直接重发。
 */
export async function discardResponse(res: Response | undefined): Promise<void> {
  if (!res || !res.body) return;
  try {
    await res.body.cancel();
  } catch {
    // 已经读掉或已关闭：无事可做
  }
}

/**
 * 只有网络层错误才重试：`TypeError: fetch failed`、ECONNREFUSED、DNS 失败等。
 * 主动 abort（用户取消 / 看门狗超时）绝不能重试 —— 那会把「停止」变成「再等一轮」。
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err) return false;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  const msg = `${err.name}: ${err.message}`.toLowerCase();
  if (/abort|cancel/.test(msg)) return false;
  return /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|network|socket hang up|other side closed|und_err/.test(
    msg,
  );
}

export function retryDelayMs(attempt: number): number {
  const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
  // 抖动是必需的：多个窗口同时被拒时，固定退避会让它们在同一毫秒再次撞上去
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/** 返回 false 表示等待期间被中止（调用方应立刻收手，不要再发请求）。 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions<T = unknown> {
  /** 重试次数上限（不含首次请求）。默认 1，即最多发两次。 */
  maxAttempts?: number;
  signal?: AbortSignal;
  /** 每次失败后、下一次重试前调用（用于日志 / 事件上报）。 */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /**
   * 服务端显式给出的等待时长（毫秒）。返回 null 表示没有提示，走指数退避。
   *
   * 单独做成回调而不是让 `withRetry` 自己看 `Response`：这个模块只管调度，
   * 不该知道调用方的返回值长什么样。
   */
  delayHintMs?: (result: T | undefined, error: unknown) => number | null;
  /**
   * 放弃一个结果对象时的清理钩子（典型场景：`Response` 的响应体）。
   *
   * 必须提供，否则被丢掉的响应体会一直占着连接 —— 重试反而让后续请求更容易超时。
   */
  dispose?: (result: T) => void | Promise<void>;
}

/** `shouldRetry` 只需回答「这次失败值得再试一次吗」，退避与计数由本模块负责。 */
export type ShouldRetry<T> = (result: T | undefined, error: unknown) => boolean;

/**
 * 执行 `attempt()` 并在可重试失败时退避重试。
 *
 * 返回最后一次的结果而不是抛出，是为了把「重试耗尽」这个事实带回给调用方，
 * 好让它决定该报什么错（通常直接把 lastError 抛出去）。
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  shouldRetry: ShouldRetry<T>,
  options: RetryOptions<T> = {},
): Promise<
  | { ok: true; value: T; attempts: number }
  | { ok: false; cancelled: boolean; attempts: number; lastError: unknown }
> {
  const total = (options.maxAttempts ?? MAX_RETRY_ATTEMPTS) + 1;
  let lastError: unknown;

  const delayFor = (value: T | undefined, error: unknown, attempt: number): number => {
    const hint = options.delayHintMs?.(value, error) ?? null;
    return hint !== null && hint > 0 ? hint : retryDelayMs(attempt);
  };

  for (let i = 0; i < total; i++) {
    const isLast = i === total - 1;
    try {
      const value = await attempt();
      if (isLast || !shouldRetry(value, undefined)) {
        return { ok: true, value, attempts: i + 1 };
      }
      const delayMs = delayFor(value, undefined, i);
      options.onRetry?.({ attempt: i + 1, delayMs, reason: describe(value, undefined) });
      if (!(await sleepAbortable(delayMs, options.signal))) {
        // 被取消时把已经拿到的响应交回去：它不是失败，只是不再重试了。
        // dispose 必须放在这之后 —— 否则会把一个已经释放掉的结果交给调用方。
        return { ok: true, value, attempts: i + 1 };
      }
      // 确认要重试了，才丢弃这个结果并释放它占用的资源（响应体 / 连接）。
      await options.dispose?.(value);
    } catch (err) {
      lastError = err;
      if (isLast || !shouldRetry(undefined, err)) break;
      const delayMs = delayFor(undefined, err, i);
      options.onRetry?.({ attempt: i + 1, delayMs, reason: describe(undefined, err) });
      if (!(await sleepAbortable(delayMs, options.signal))) {
        return { ok: false, cancelled: true, attempts: i + 1, lastError: err };
      }
    }
  }
  return { ok: false, cancelled: false, attempts: total, lastError };
}

function describe(value: unknown, error: unknown): string {
  if (error) return error instanceof Error ? error.message : String(error);
  if (typeof Response !== 'undefined' && value instanceof Response) {
    return `HTTP ${value.status}`;
  }
  return String(value);
}
