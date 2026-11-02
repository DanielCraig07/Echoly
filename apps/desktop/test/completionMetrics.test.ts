import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCompletionMetrics,
  recordCompletionAccepted,
  recordCompletionOutcome,
  recordCompletionRequest,
  resetCompletionMetrics,
  subscribeCompletionMetrics,
} from '../src/renderer/src/services/completionMetrics';

/**
 * 补全埋点。
 *
 * 这些数字是后面所有补全优化的**唯一验收依据**，所以算错的代价很高：
 * 接受率的分母搞错，就会把「建议给得更多」误读成「建议更准」。
 */

function stubLocalStorage(): void {
  let store: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
  };
}

describe('completionMetrics', () => {
  beforeEach(() => {
    stubLocalStorage();
    resetCompletionMetrics();
  });

  it('分开统计请求数与四种结局', () => {
    recordCompletionRequest();
    recordCompletionOutcome('succeeded', 120);
    recordCompletionRequest();
    recordCompletionOutcome('empty', 80);
    recordCompletionRequest();
    recordCompletionOutcome('failed', 30);
    recordCompletionOutcome('cancelled');

    const m = getCompletionMetrics();
    expect(m.requested).toBe(3);
    expect(m.succeeded).toBe(1);
    expect(m.empty).toBe(1);
    expect(m.failed).toBe(1);
    expect(m.cancelled).toBe(1);
  });

  it('接受率的分母是「成功返回建议数」，不是请求数', () => {
    // 请求了 4 次，只有 2 次真的给出建议，用户接受了 1 次 → 50%，而不是 25%。
    // 用请求数当分母会把「模型没话可说」算成「建议不被采纳」，两件事完全不同。
    recordCompletionRequest();
    recordCompletionOutcome('succeeded', 100);
    recordCompletionRequest();
    recordCompletionOutcome('succeeded', 100);
    recordCompletionRequest();
    recordCompletionOutcome('empty', 40);
    recordCompletionRequest();
    recordCompletionOutcome('failed', 10);
    recordCompletionAccepted();

    const m = getCompletionMetrics();
    expect(m.accepted).toBe(1);
    expect(m.acceptanceRate).toBeCloseTo(0.5);
  });

  it('没有任何成功建议时接受率是 0 而不是 NaN', () => {
    recordCompletionRequest();
    recordCompletionOutcome('failed', 10);
    expect(getCompletionMetrics().acceptanceRate).toBe(0);
  });

  it('取消不计入延迟样本', () => {
    // 取消的耗时反映的是「用户多快又敲了一下」，混进平均延迟会让指标失去意义
    recordCompletionOutcome('succeeded', 200);
    recordCompletionOutcome('cancelled', 9999);
    const m = getCompletionMetrics();
    expect(m.avgLatencyMs).toBe(200);
    expect(m.lastLatencyMs).toBe(200);
  });

  it('平均延迟与 P95', () => {
    for (const ms of [100, 200, 300, 400, 1000]) {
      recordCompletionOutcome('succeeded', ms);
    }
    const m = getCompletionMetrics();
    expect(m.avgLatencyMs).toBe(400);
    expect(m.p95LatencyMs).toBe(1000);
    expect(m.lastLatencyMs).toBe(1000);
  });

  it('延迟样本只留最近 200 次', () => {
    for (let i = 0; i < 250; i++) recordCompletionOutcome('succeeded', i);
    const m = getCompletionMetrics();
    // 只留 i=50..249，均值 = 149.5
    expect(m.avgLatencyMs).toBeCloseTo(149.5);
    // 最近邻插值：200 个样本里第 190 小的值，即 50+189
    expect(m.p95LatencyMs).toBe(239);
  });

  it('重置把计数与延迟一起清零', () => {
    recordCompletionRequest();
    recordCompletionOutcome('succeeded', 500);
    recordCompletionAccepted();
    resetCompletionMetrics();

    const m = getCompletionMetrics();
    expect(m.requested).toBe(0);
    expect(m.accepted).toBe(0);
    expect(m.avgLatencyMs).toBe(0);
  });

  it('统计写进 localStorage，重开也能接着算', async () => {
    recordCompletionRequest();
    recordCompletionOutcome('succeeded', 250);
    recordCompletionAccepted();

    vi.resetModules();
    const reloaded = await import('../src/renderer/src/services/completionMetrics');
    const m = reloaded.getCompletionMetrics();
    expect(m.requested).toBe(1);
    expect(m.accepted).toBe(1);
    expect(m.avgLatencyMs).toBe(250);
  });

  it('存的内容坏掉时退回全零，而不是抛错', async () => {
    localStorage.setItem('echoly:completion_metrics', '{ not json');
    vi.resetModules();
    const reloaded = await import('../src/renderer/src/services/completionMetrics');
    expect(reloaded.getCompletionMetrics().requested).toBe(0);
  });

  it('localStorage 不可用时统计照常工作（只是记不住）', () => {
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error('隐私模式');
      },
      setItem: () => {
        throw new Error('配额已满');
      },
    };
    resetCompletionMetrics();
    recordCompletionRequest();
    recordCompletionOutcome('succeeded', 50);
    expect(getCompletionMetrics().requested).toBe(1);
  });

  it('订阅者在记录后收到通知，退订后不再收到', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCompletionMetrics(listener);
    recordCompletionRequest();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    recordCompletionRequest();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('单个订阅者抛错不影响其他订阅者', () => {
    const healthy = vi.fn();
    subscribeCompletionMetrics(() => {
      throw new Error('订阅者炸了');
    });
    subscribeCompletionMetrics(healthy);
    expect(() => recordCompletionRequest()).not.toThrow();
    expect(healthy).toHaveBeenCalled();
  });
});
