/**
 * AI 行内补全的**本地**统计。
 *
 * 为什么先做这个：补全优化（结构化输出、FIM 后缀、多行建议）每一项都要动 prompt
 * 或请求编排，而「改了之后到底变好没有」如果只靠感觉，很容易把「更啰嗦」当成「更准」。
 * 接受率与延迟是唯一能证伪的指标，所以先埋点、再优化。
 *
 * 三条约束：
 * 1. **只统计、不上报。** 数字留在本机 localStorage，不出进程、不进日志文件。
 *    补全的上下文是用户正在写的代码，把它变成可上报的数据是另一件性质的事，
 *    真要做得先有隐私开关（见 PLAN 的「隐私模式」）。
 * 2. **不因为统计失败而影响补全。** localStorage 读写一律 try/catch：
 *    隐私模式或配额满时读不到，最多是统计从零开始。
 * 3. **延迟只留最近 N 次。** 保留全部样本会让「平均延迟」被几万次历史请求拖住，
 *    看不出刚刚这次优化有没有用。
 */

export interface CompletionMetricsSnapshot {
  /** 实际发出的补全请求数（防抖命中、取消都没走到这里的除外） */
  requested: number;
  /** 拿到非空建议的次数 */
  succeeded: number;
  /** 请求成功但没给出可用建议（模型回空、只回了 markdown 围栏） */
  empty: number;
  /** 请求抛错的次数 */
  failed: number;
  /** 返回前被取消的次数（用户继续打字、切走光标） */
  cancelled: number;
  /** 用户接受建议的次数 */
  accepted: number;
  /** 接受数 / 成功返回建议数。分母为 0 时是 0，不是 NaN */
  acceptanceRate: number;
  /** 已完成请求的平均耗时（毫秒） */
  avgLatencyMs: number;
  /** 延迟的 95 分位。平均值会被极快的缓存命中拉低，长尾得看这个 */
  p95LatencyMs: number;
  lastLatencyMs: number;
  /** 统计起点（首次记录或被重置的时间） */
  since: number;
}

interface Counters {
  requested: number;
  succeeded: number;
  empty: number;
  failed: number;
  cancelled: number;
  accepted: number;
  latencies: number[];
  since: number;
}

const STORAGE_KEY = 'echoly:completion_metrics';

/** 延迟样本上限。见文件头第 3 条。 */
const MAX_LATENCY_SAMPLES = 200;

function emptyCounters(): Counters {
  return {
    requested: 0,
    succeeded: 0,
    empty: 0,
    failed: 0,
    cancelled: 0,
    accepted: 0,
    latencies: [],
    since: Date.now(),
  };
}

function load(): Counters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyCounters();
    const parsed = JSON.parse(raw) as Partial<Counters>;
    const base = emptyCounters();
    return {
      requested: numberOr(parsed.requested, base.requested),
      succeeded: numberOr(parsed.succeeded, base.succeeded),
      empty: numberOr(parsed.empty, base.empty),
      failed: numberOr(parsed.failed, base.failed),
      cancelled: numberOr(parsed.cancelled, base.cancelled),
      accepted: numberOr(parsed.accepted, base.accepted),
      latencies: Array.isArray(parsed.latencies)
        ? parsed.latencies
            .filter((n): n is number => typeof n === 'number')
            .slice(-MAX_LATENCY_SAMPLES)
        : [],
      since: numberOr(parsed.since, base.since),
    };
  } catch {
    // 存坏了/读不到都只意味着统计从头开始，不该让补全本身受影响
    return emptyCounters();
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

let counters: Counters = load();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(counters));
  } catch {
    // 记不住统计不影响补全
  }
}

function commit(): void {
  persist();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不该影响其他订阅者，更不该影响补全
    }
  }
}

/** 记录一次真正发出的请求。 */
export function recordCompletionRequest(): void {
  counters.requested += 1;
  commit();
}

export type CompletionOutcome = 'succeeded' | 'empty' | 'failed' | 'cancelled';

/**
 * 记录一次请求的结局。
 *
 * `cancelled` 的耗时反映的是「用户多快又敲了一下」，混进延迟里会让平均值失去意义，
 * 所以这里**显式丢弃**取消样本的延迟 —— 不在调用方约定，而是在这里兜住：
 * 调用方将来多传一个延迟参数，也不该把指标弄脏。
 */
export function recordCompletionOutcome(outcome: CompletionOutcome, latencyMs?: number): void {
  if (outcome === 'succeeded') counters.succeeded += 1;
  else if (outcome === 'empty') counters.empty += 1;
  else if (outcome === 'failed') counters.failed += 1;
  else counters.cancelled += 1;

  if (
    outcome !== 'cancelled' &&
    latencyMs !== undefined &&
    Number.isFinite(latencyMs) &&
    latencyMs >= 0
  ) {
    counters.latencies.push(latencyMs);
    if (counters.latencies.length > MAX_LATENCY_SAMPLES) {
      counters.latencies.splice(0, counters.latencies.length - MAX_LATENCY_SAMPLES);
    }
  }
  commit();
}

/**
 * 记录用户接受了建议。
 *
 * 这是整套指标里最容易被算错的一个：Monaco 不会告诉我们「用户按了 Tab」，
 * 只能从「光标处真的插入了我们建议过的文本」反推（见 `inlineCompletion.ts`）。
 */
export function recordCompletionAccepted(): void {
  counters.accepted += 1;
  commit();
}

export function getCompletionMetrics(): CompletionMetricsSnapshot {
  const { requested, succeeded, empty, failed, cancelled, accepted, latencies, since } = counters;
  return {
    requested,
    succeeded,
    empty,
    failed,
    cancelled,
    accepted,
    acceptanceRate: succeeded > 0 ? accepted / succeeded : 0,
    avgLatencyMs: mean(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    lastLatencyMs: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
    since,
  };
}

export function resetCompletionMetrics(): void {
  counters = emptyCounters();
  commit();
}

/** 订阅统计变化；返回退订函数。 */
export function subscribeCompletionMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** 最近邻插值分位数，样本少时也不会给出离谱的值。 */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
