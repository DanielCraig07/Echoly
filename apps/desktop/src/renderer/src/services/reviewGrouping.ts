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

function normalizePath(input: string): string {
  return (input ?? '').replace(/\\/g, '/').toLowerCase();
}
