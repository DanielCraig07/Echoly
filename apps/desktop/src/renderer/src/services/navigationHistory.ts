/**
 * 文件导航历史（纯逻辑）。
 *
 * 标题栏的前进/后退要的是「我刚刚从哪个文件跳过来的」。浏览器式的历史栈语义有几个
 * 容易做错的边界，集中放在这里、用测试钉住，比散在组件的 setState 里可靠：
 *
 * 1. **在历史中间打开新文件，必须截断后面的记录。** 否则「后退」会走到一条
 *    已经从当前分支上分叉出去的路径，用户会觉得自己被传送到了莫名其妙的地方。
 * 2. **重复打开同一个文件不该堆记录。** 在同一个文件里点了十次，后退一次就该回到
 *    上一个文件，而不是原地不动十次。
 * 3. **栈要有上限。** 一次会话里跳几百个文件是常态，无上限就是一个慢性内存泄漏，
 *    而且超长的历史对用户也没有意义。
 */

export interface NavigationHistory<T = string> {
  entries: T[];
  /** 当前位置在 entries 中的下标；-1 表示还没有任何记录 */
  index: number;
}

/** 历史深度上限。超出后从最旧的一端丢弃。 */
export const MAX_HISTORY_ENTRIES = 50;

export function createHistory<T = string>(): NavigationHistory<T> {
  return { entries: [], index: -1 };
}

export function currentEntry<T>(history: NavigationHistory<T>): T | undefined {
  return history.index >= 0 ? history.entries[history.index] : undefined;
}

/**
 * 记录一次跳转。
 *
 * 与当前项相同时原样返回（连对象引用都不换），让调用方可以直接用它做
 * `setState` 前的相等性判断，避免无意义的重渲染。
 */
export function pushEntry<T>(history: NavigationHistory<T>, entry: T): NavigationHistory<T> {
  if (currentEntry(history) === entry) return history;

  // 从历史中间再次跳转：丢弃当前位置之后的分支
  const kept = history.index >= 0 ? history.entries.slice(0, history.index + 1) : [];
  const entries = [...kept, entry];

  const overflow = Math.max(0, entries.length - MAX_HISTORY_ENTRIES);
  const trimmed = overflow > 0 ? entries.slice(overflow) : entries;

  return { entries: trimmed, index: trimmed.length - 1 };
}

export function canGoBack<T>(history: NavigationHistory<T>): boolean {
  return history.index > 0;
}

export function canGoForward<T>(history: NavigationHistory<T>): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

export function goBack<T>(history: NavigationHistory<T>): NavigationHistory<T> {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function goForward<T>(history: NavigationHistory<T>): NavigationHistory<T> {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}
