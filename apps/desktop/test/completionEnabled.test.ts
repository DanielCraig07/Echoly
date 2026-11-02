import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isAiCompletionEnabled,
  setAiCompletionEnabled,
  subscribeAiCompletionEnabled,
} from '../src/renderer/src/services/completionEnabled';

/**
 * 补全总开关。
 *
 * 这个开关以前是假的（状态栏按钮只改文案，补全照发请求），
 * 所以用例重点在「关掉之后真的关掉了」以及「偏好记得住」。
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

describe('aiCompletionEnabled', () => {
  beforeEach(() => {
    stubLocalStorage();
    // 用静态导入的那个实例做归一化。`vi.resetModules()` 会新建一个模块实例，
    // 而文件顶部的静态 import 仍然指向旧实例 —— 两者混用只会让断言的对象对不上。
    setAiCompletionEnabled(true);
  });

  it('默认开启', () => {
    expect(isAiCompletionEnabled()).toBe(true);
  });

  it('关掉之后立即生效', () => {
    setAiCompletionEnabled(false);
    expect(isAiCompletionEnabled()).toBe(false);
    setAiCompletionEnabled(true);
    expect(isAiCompletionEnabled()).toBe(true);
  });

  it('偏好写进 localStorage，重开仍是关掉的', async () => {
    setAiCompletionEnabled(false);
    vi.resetModules();
    const reloaded = await import('../src/renderer/src/services/completionEnabled');
    expect(reloaded.isAiCompletionEnabled()).toBe(false);
  });

  it('状态没变时不通知订阅者', () => {
    const listener = vi.fn();
    subscribeAiCompletionEnabled(listener);
    setAiCompletionEnabled(true); // 本来就是 true
    expect(listener).not.toHaveBeenCalled();
    setAiCompletionEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('退订后不再收到通知', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAiCompletionEnabled(listener);
    unsubscribe();
    setAiCompletionEnabled(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('localStorage 不可用时退回默认开启且不抛错', async () => {
    (globalThis as any).localStorage = {
      getItem: () => {
        throw new Error('隐私模式');
      },
      setItem: () => {
        throw new Error('配额已满');
      },
    };
    vi.resetModules();
    const reloaded = await import('../src/renderer/src/services/completionEnabled');
    expect(reloaded.isAiCompletionEnabled()).toBe(true);
    expect(() => reloaded.setAiCompletionEnabled(false)).not.toThrow();
    expect(reloaded.isAiCompletionEnabled()).toBe(false);
  });
});
