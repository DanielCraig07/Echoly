import type { PendingDiff } from '@deepseek-ide/shared';

/**
 * Review 面板的文件分组（纯逻辑）。
 *
 * 一轮 Agent 跑完会产出多个 `PendingDiff`，而**同一个文件可能出现多次**——
 * Agent 先改一处、看诊断、再改一处，每次都会生成一条独立记录。审阅时按文件聚合，
 * 用户才能「看完这个文件的全部改动再决定接受还是拒绝」，而不是在同一个文件上来回跳。
 *
 * 这里刻意**不计算增删行数**：行级统计已有 `services/diffStats.ts` 在做，
 * 再实现一份迟早会与它分叉（一个把空行算作改动、另一个不算之类），
 * 到时候两个界面上显示的数字对不上，反而更难查。
 */

export interface ReviewFileGroup {
  /** 文件相对路径 */
  path: string;
  /** 该文件下的改动记录 id，按出现顺序 */
  diffIds: string[];
  /** 该文件是否包含「新建文件」（original 为空）的改动 */
  hasNewFile: boolean;
}

/**
 * 按文件聚合一轮的改动。
 *
 * 顺序取**首次出现的次序**而不是字母序：Agent 的改动顺序本身就是一种信息，
 * 按字母重排会把这个线索丢掉，而用户顺着读下来更接近 Agent 当初的推理路径。
 */
export function groupDiffsByFile(diffs: readonly PendingDiff[]): ReviewFileGroup[] {
  const groups = new Map<string, ReviewFileGroup>();

  for (const diff of diffs) {
    // 路径大小写不敏感去重：同一次会话里 Windows 盘符与用户手输路径可能大小写不一致，
    // 那会让同一个文件裂成两组，用户以为有两处改动
    const key = normalizePath(diff.path);
    const existing = groups.get(key);
    if (existing) {
      existing.diffIds.push(diff.id);
      if (isNewFile(diff)) existing.hasNewFile = true;
      continue;
    }
    groups.set(key, {
      path: diff.path,
      diffIds: [diff.id],
      hasNewFile: isNewFile(diff),
    });
  }

  return Array.from(groups.values());
}

/** 新建文件的判定：写之前没有任何内容。 */
export function isNewFile(diff: PendingDiff): boolean {
  return (diff.original ?? '') === '' && (diff.modified ?? '') !== '';
}

/**
 * 键盘导航：把焦点索引移动 `delta` 步。
 *
 * **两端截断，不循环。** 从最后一个文件按 J 跳回第一个，在审阅这种「逐个看、
 * 看完就过」的流程里很迷惑 —— 用户会以为还有没看过的东西。
 * 空列表返回 -1，调用方据此不做任何渲染。
 */
export function moveReviewFocus(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  const base = current < 0 ? (delta > 0 ? 0 : count - 1) : current + delta;
  return Math.max(0, Math.min(count - 1, base));
}

/** 一个审阅批次 = 一轮 Agent 运行产生的全部改动。 */
export interface ReviewBatch {
  /** 轮次 id；旧数据没有标记时为 null */
  runId: string | null;
  /**
   * 按位置给的标签，而不是显示原始 runId —— 一串 UUID 对用户没有意义。
   * 用户真正需要区分的是「刚跑完这轮」与「之前留下的」。
   */
  label: 'latest' | 'previous' | 'older';
  groups: ReviewFileGroup[];
  diffIds: string[];
}

/**
 * 按轮次分批。**最新的批次排在最前**：用户是在一轮跑完之后打开这个面板的，
 * 想看的首先是刚改完的东西，而不是往上翻过历史。
 */
export function groupDiffsByBatch(diffs: readonly PendingDiff[]): ReviewBatch[] {
  const order: (string | null)[] = [];
  const byRun = new Map<string | null, PendingDiff[]>();

  for (const diff of diffs) {
    const key = diff.runId ?? null;
    if (!byRun.has(key)) {
      byRun.set(key, []);
      order.push(key);
    }
    byRun.get(key)!.push(diff);
  }

  return order
    .map((key) => byRun.get(key)!)
    .reverse()
    .map((batchDiffs, index) => ({
      runId: batchDiffs[0]?.runId ?? null,
      label: index === 0 ? 'latest' : index === 1 ? 'previous' : 'older',
      groups: groupDiffsByFile(batchDiffs),
      diffIds: batchDiffs.map((d) => d.id),
    }));
}

function normalizePath(input: string): string {
  return (input ?? '').replace(/\\/g, '/').toLowerCase();
}
