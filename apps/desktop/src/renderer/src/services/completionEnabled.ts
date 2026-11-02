/**
 * AI 行内补全的总开关。
 *
 * 之前这个开关是**假的**：状态栏那个 ✨ Copilot 按钮只改了自己的文案与颜色，
 * 补全提供者照样注册、照样请求。点了「已暂停」却仍在发请求，
 * 比没有开关更糟 —— 用户据此以为关掉了，实际没有。
 *
 * 所以这里把它做成一份**请求时真正会被读到**的状态：`inlineCompletion.ts`
 * 每次响应前先问一句，关掉时直接返回空建议、连 IPC 都不发。
 *
 * 存 localStorage 而不是 settings.json：与「表结构视图形态」同一类东西 ——
 * 纯本机界面偏好，丢了只是回到默认值。
 */

const STORAGE_KEY = 'echoly:ai_completion_enabled';

/** 默认开：装完就能用是补全这类功能的默认预期。 */
const DEFAULT_ENABLED = true;

const listeners = new Set<() => void>();

let enabled = load();

function load(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_ENABLED : raw === '1';
  } catch {
    return DEFAULT_ENABLED;
  }
}

export function isAiCompletionEnabled(): boolean {
  return enabled;
}

export function setAiCompletionEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // 记不住偏好不影响本次会话内的开关
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不该影响其他订阅者
    }
  }
}

export function subscribeAiCompletionEnabled(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
