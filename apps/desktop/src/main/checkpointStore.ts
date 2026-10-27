import fs from 'node:fs';
import path from 'node:path';
import type {
  CheckpointSummary,
  CheckpointDetail,
  CheckpointMutationDetail,
} from '@deepseek-ide/shared';
import type { FileMutation, RevertResult, WorkspaceBackend } from '@deepseek-ide/tools';
import { revertMutations } from '@deepseek-ide/tools';
import { writeFileAtomic } from './atomicWrite';

/**
 * 按「轮」保存文件系统的写前记录，支持一键撤销本轮 AI 改动。
 *
 * 为什么不是给 `DiffStore` 加一个 undo 栈：diff 的生命周期是「等用户 accept/reject」，
 * 一旦用户点了 Accept all 就被清空 —— 而那时恰恰是用户最想反悔的时刻。
 * 撤销需要的是独立于 diff 决策之外的、按 runId 归集的写前快照，
 * 所以这里只负责攒记录，diff 的清理交给 ipc 层在撤销成功后顺手做掉。
 *
 * 保留策略：内存中只缓存最近若干轮。全量写前快照同步持久化在 userData/checkpoints/ 下，
 * 确保重开会话、重启应用或切换工作区后依然可以审查历史差异并安全执行撤销。
 */

export type { CheckpointSummary, CheckpointDetail };

const MAX_RETAINED_RUNS = 10;

/** 将一轮内针对同一文件的多次操作聚合为单条变动（初始态 → 最终态） */
export function aggregateMutations(mutations: FileMutation[]): CheckpointMutationDetail[] {
  const orderedPaths: string[] = [];
  const map = new Map<
    string,
    {
      initialOriginal: string | null;
      finalWritten: string | null;
      kind: 'write' | 'delete' | 'move' | 'unrecordable';
      from?: string;
      to?: string;
      reason?: string;
      isDeleted?: boolean;
    }
  >();

  for (const m of mutations) {
    const key = m.kind === 'move' ? m.to : m.path;
    let record = map.get(key);

    if (!record) {
      orderedPaths.push(key);
      record = {
        initialOriginal: null,
        finalWritten: null,
        kind: m.kind,
      };
      map.set(key, record);

      if (m.kind === 'write') {
        record.initialOriginal = m.original;
        record.finalWritten = m.written;
      } else if (m.kind === 'delete') {
        record.initialOriginal = m.snapshot ? (m.snapshot.files[0]?.content ?? null) : null;
        record.finalWritten = null;
        record.isDeleted = true;
        const fileCount = m.snapshot?.files.length ?? 0;
        if (fileCount > 1) record.reason = `目录包含 ${fileCount} 个文件`;
      } else if (m.kind === 'move') {
        record.from = m.from;
        record.to = m.to;
      } else if (m.kind === 'unrecordable') {
        record.reason = m.reason;
      }
    } else {
      if (m.kind === 'write') {
        record.finalWritten = m.written;
        record.kind = 'write';
        record.isDeleted = false;
      } else if (m.kind === 'delete') {
        record.finalWritten = null;
        record.isDeleted = true;
        record.kind = 'delete';
        const fileCount = m.snapshot?.files.length ?? 0;
        if (fileCount > 1) record.reason = `目录包含 ${fileCount} 个文件`;
      } else if (m.kind === 'move') {
        record.to = m.to;
        record.kind = 'move';
      } else if (m.kind === 'unrecordable') {
        record.kind = 'unrecordable';
        record.reason = m.reason;
      }
    }
  }

  const result: CheckpointMutationDetail[] = [];
  for (const path of orderedPaths) {
    const rec = map.get(path);
    if (!rec) continue;
    if (rec.kind === 'move') {
      result.push({
        kind: 'move',
        path,
        from: rec.from,
        to: rec.to,
        original: null,
        written: null,
      });
    } else if (rec.kind === 'delete') {
      result.push({
        kind: 'delete',
        path,
        original: rec.initialOriginal,
        written: null,
        reason: rec.reason,
      });
    } else if (rec.kind === 'unrecordable') {
      result.push({
        kind: 'unrecordable',
        path,
        original: null,
        written: null,
        reason: rec.reason,
      });
    } else {
      result.push({
        kind: 'write',
        path,
        original: rec.initialOriginal,
        written: rec.finalWritten,
      });
    }
  }
  return result;
}

export class CheckpointStore {
  private runs = new Map<string, { mutations: FileMutation[]; createdAt: number }>();
  private order: string[] = [];
  private storageDir?: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir;
    if (this.storageDir) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }

  setStorageDir(storageDir: string): void {
    this.storageDir = storageDir;
    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  private checkpointPath(runId: string): string | null {
    if (!this.storageDir) return null;
    const safeName = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `${safeName}.json`);
  }

  private persistToDisk(
    runId: string,
    entry: { mutations: FileMutation[]; createdAt: number },
  ): void {
    const p = this.checkpointPath(runId);
    if (!p) return;
    try {
      writeFileAtomic(
        p,
        JSON.stringify(
          {
            runId,
            createdAt: entry.createdAt,
            mutations: entry.mutations,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.warn(`[CheckpointStore] Failed to persist checkpoint ${runId}:`, err);
    }
  }

  private loadFromDisk(runId: string): { mutations: FileMutation[]; createdAt: number } | null {
    const p = this.checkpointPath(runId);
    if (!p) return null;
    try {
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, 'utf8');
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.mutations)) {
        const entry = {
          mutations: data.mutations as FileMutation[],
          createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
        };
        this.runs.set(runId, entry);
        if (!this.order.includes(runId)) {
          this.order.push(runId);
        }
        return entry;
      }
    } catch (err) {
      console.warn(`[CheckpointStore] Failed to read checkpoint ${runId} from disk:`, err);
    }
    return null;
  }

  begin(runId: string): void {
    const entry = { mutations: [], createdAt: Date.now() };
    this.runs.set(runId, entry);
    this.order = [...this.order.filter((id) => id !== runId), runId];
    while (this.order.length > MAX_RETAINED_RUNS) {
      const dropped = this.order.shift();
      if (dropped) this.runs.delete(dropped);
    }
  }

  record(runId: string, mutation: FileMutation): void {
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = this.loadFromDisk(runId) ?? undefined;
    }
    if (!entry) return;
    entry.mutations.push(mutation);
    this.persistToDisk(runId, entry);
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
    let entry = this.runs.get(id);
    if (!entry) {
      entry = this.loadFromDisk(id) ?? undefined;
    }
    if (!entry || entry.mutations.length === 0) return null;
    const bad = entry.mutations.find((m) => m.kind === 'unrecordable');
    const aggregated = aggregateMutations(entry.mutations);
    return {
      runId: id,
      mutations: entry.mutations.length,
      fileCount: aggregated.length,
      incomplete: Boolean(bad),
      incompleteReason:
        bad && bad.kind === 'unrecordable' ? `${bad.path}: ${bad.reason}` : undefined,
      createdAt: entry.createdAt,
    };
  }

  /** 获取本轮改动详情，包含所有具体文件的原始快照与变更信息（已按文件路径去重聚合） */
  detail(runId?: string): CheckpointDetail | null {
    const id = runId ?? this.latest();
    if (!id) return null;
    let entry = this.runs.get(id);
    if (!entry) {
      entry = this.loadFromDisk(id) ?? undefined;
    }
    if (!entry || entry.mutations.length === 0) return null;
    const bad = entry.mutations.find((m) => m.kind === 'unrecordable');
    const files = aggregateMutations(entry.mutations);

    return {
      runId: id,
      mutations: entry.mutations.length,
      fileCount: files.length,
      incomplete: Boolean(bad),
      incompleteReason:
        bad && bad.kind === 'unrecordable' ? `${bad.path}: ${bad.reason}` : undefined,
      createdAt: entry.createdAt,
      files,
    };
  }

  /**
   * 撤销一轮（可选择全量撤销或仅撤销指定文件）。
   */
  async revert(
    backend: WorkspaceBackend,
    runId?: string,
    options?: { paths?: string[]; force?: boolean },
  ): Promise<{ result: RevertResult; runId: string } | { error: string }> {
    const id = runId ?? this.latest();
    if (!id) return { error: '没有可撤销的 AI 改动记录。' };
    let entry = this.runs.get(id);
    if (!entry) {
      entry = this.loadFromDisk(id) ?? undefined;
    }
    if (!entry || entry.mutations.length === 0) {
      return { error: '本轮没有文件改动，无需撤销。' };
    }
    const bad = entry.mutations.find((m) => m.kind === 'unrecordable');
    // 如果用户指定了路径且所选路径不包含不可留底文件，允许继续
    if (
      bad &&
      bad.kind === 'unrecordable' &&
      (!options?.paths || options.paths.includes(bad.path))
    ) {
      return {
        error: `本轮包含无法完整留底的操作（${bad.path}：${bad.reason}），为避免只还原一半，已放弃自动撤销。请用 Git 还原。`,
      };
    }

    const result = await revertMutations(backend, entry.mutations, options);

    // 撤销成功后处理记录：
    // 若指定了部分路径，只剔除成功还原的文件，其余文件仍保留在记录中可供后续继续回退
    if (result.reverted.length > 0) {
      if (options?.paths && options.paths.length > 0) {
        const revertedSet = new Set(result.reverted);
        entry.mutations = entry.mutations.filter(
          (m) =>
            !revertedSet.has(m.kind === 'move' ? m.from : m.path) &&
            (m.kind !== 'move' || !revertedSet.has(m.to)),
        );
        if (entry.mutations.length === 0) {
          this.runs.delete(id);
          this.order = this.order.filter((x) => x !== id);
          const p = this.checkpointPath(id);
          if (p && fs.existsSync(p)) {
            try {
              fs.unlinkSync(p);
            } catch {}
          }
        } else {
          this.persistToDisk(id, entry);
        }
      } else {
        this.runs.delete(id);
        this.order = this.order.filter((x) => x !== id);
        const p = this.checkpointPath(id);
        if (p && fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch {}
        }
      }
    }
    return { result, runId: id };
  }

  clear(): void {
    this.runs.clear();
    this.order = [];
  }
}
