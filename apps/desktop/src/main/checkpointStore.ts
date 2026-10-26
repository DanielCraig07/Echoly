import type { CheckpointSummary } from '@deepseek-ide/shared';
import type { FileMutation, RevertResult, WorkspaceBackend } from '@deepseek-ide/tools';
import { revertMutations } from '@deepseek-ide/tools';

/**
 * 按「轮」保存文件系统的写前记录，支持一键撤销本轮 AI 改动。
 *
 * 为什么不是给 `DiffStore` 加一个 undo 栈：diff 的生命周期是「等用户 accept/reject」，
 * 一旦用户点了 Accept all 就被清空 —— 而那时恰恰是用户最想反悔的时刻。
 * 撤销需要的是独立于 diff 决策之外的、按 runId 归集的写前快照，
 * 所以这里只负责攒记录，diff 的清理交给 ipc 层在撤销成功后顺手做掉。
 *
 * 保留策略：每个窗口只留最近若干轮。记录里带着被删文件的完整正文，
 * 全量留存等于把用户删过的所有内容常驻内存。
 */

export type { CheckpointSummary };

const MAX_RETAINED_RUNS = 10;

export class CheckpointStore {
  private runs = new Map<string, { mutations: FileMutation[]; createdAt: number }>();
  private order: string[] = [];

  begin(runId: string): void {
    this.runs.set(runId, { mutations: [], createdAt: Date.now() });
    this.order = [...this.order.filter((id) => id !== runId), runId];
    while (this.order.length > MAX_RETAINED_RUNS) {
      const dropped = this.order.shift();
      if (dropped) this.runs.delete(dropped);
    }
  }

  record(runId: string, mutation: FileMutation): void {
    const entry = this.runs.get(runId);
    if (!entry) return;
    entry.mutations.push(mutation);
  }

  /** 最近一轮有记录的 runId；没有任何记录时返回 null。 */
  latest(): string | null {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const entry = this.runs.get(this.order[i]);
      if (entry && entry.mutations.length > 0) return this.order[i];
    }
    return null;
  }

  summary(runId?: string): CheckpointSummary | null {
    const id = runId ?? this.latest();
    if (!id) return null;
    const entry = this.runs.get(id);
    if (!entry || entry.mutations.length === 0) return null;
    const bad = entry.mutations.find((m) => m.kind === 'unrecordable');
    return {
      runId: id,
      mutations: entry.mutations.length,
      incomplete: Boolean(bad),
      incompleteReason: bad && bad.kind === 'unrecordable' ? `${bad.path}: ${bad.reason}` : undefined,
      createdAt: entry.createdAt,
    };
  }

  /**
   * 撤销一轮。
   *
   * 有「无法记录」的操作时直接拒绝整轮：部分撤销比不撤销更危险 ——
   * 用户看到「已撤销」，却仍有一半改动留在工作区里，而这份错觉会让他不再去检查。
   */
  async revert(
    backend: WorkspaceBackend,
    runId?: string,
  ): Promise<{ result: RevertResult; runId: string } | { error: string }> {
    const id = runId ?? this.latest();
    if (!id) return { error: '没有可撤销的 AI 改动记录。' };
    const entry = this.runs.get(id);
    if (!entry || entry.mutations.length === 0) {
      return { error: '本轮没有文件改动，无需撤销。' };
    }
    const bad = entry.mutations.find((m) => m.kind === 'unrecordable');
    if (bad && bad.kind === 'unrecordable') {
      return {
        error: `本轮包含无法完整留底的操作（${bad.path}：${bad.reason}），为避免只还原一半，已放弃自动撤销。请用 Git 还原。`,
      };
    }

    const result = await revertMutations(backend, entry.mutations);
    // 撤销成功后本轮记录即失效：再点一次会把用户手改的内容回退到自己身上
    this.runs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    return { result, runId: id };
  }

  clear(): void {
    this.runs.clear();
    this.order = [];
  }
}
