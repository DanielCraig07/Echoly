import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { PendingDiff } from '@deepseek-ide/shared';
import type { WorkspaceService } from './workspace';

export class DiffStore {
  private diffs = new Map<string, PendingDiff>();

  constructor(private readonly workspace: WorkspaceService) {}

  add(diff: PendingDiff): void {
    this.diffs.set(diff.id, diff);
  }

  get(id: string): PendingDiff | undefined {
    return this.diffs.get(id);
  }

  list(): PendingDiff[] {
    return [...this.diffs.values()];
  }

  /**
   * 采纳一条 diff 并写入磁盘。
   *
   * **写失败必须让调用方知道**。旧实现把 `writeFile` 的异常吞掉，然后照样
   * `this.diffs.delete(id)` —— 于是磁盘写入失败（只读文件系统、文件被别的进程占住、
   * 权限不足、工作区已被卸载）时，界面上的 diff 消失了，用户以为改动已生效，
   * 实际磁盘一个字都没变。这类"看起来成功了"的失败比直接报错危险得多：
   * 用户会接着去做依赖这次改动的下一步。
   *
   * 所以：失败时**保留**这条 diff（用户还能重试），并把异常抛给 IPC 层，
   * 由界面显示具体错误。
   */
  async accept(id: string): Promise<void> {
    const diff = this.diffs.get(id);
    if (!diff) return;
    try {
      await this.workspace.writeFile(diff.path, diff.modified);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`写入 ${diff.path} 失败：${message}`);
    }
    this.diffs.delete(id);
  }

  async reject(id: string): Promise<void> {
    const diff = this.diffs.get(id);
    if (!diff) return;
    try {
      await this.workspace.writeFile(diff.path, diff.original);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`还原 ${diff.path} 失败：${message}`);
    }
    this.diffs.delete(id);
  }

  /**
   * 全部采纳 / 全部放弃：逐条处理，**一条失败不中断其余**。
   *
   * 与单条不同，这里的语义是"尽力而为"：三条里有一条被占住，另外两条没有理由
   * 跟着不写。失败的条目原样留在列表里（accept/reject 已经保证了这点），
   * 最后统一把失败路径抛出去，让界面一次性告诉用户哪几个没成功。
   */
  async acceptAll(): Promise<void> {
    await this.runAll((id) => this.accept(id));
  }

  async rejectAll(): Promise<void> {
    await this.runAll((id) => this.reject(id));
  }

  private async runAll(op: (id: string) => Promise<void>): Promise<void> {
    const failures: string[] = [];
    for (const id of [...this.diffs.keys()]) {
      try {
        await op(id);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (failures.length > 0) {
      throw new Error(`${failures.length} 个文件未能写入：${failures.join('；')}`);
    }
  }

  /**
   * 丢弃一条 diff，**不碰磁盘**。
   *
   * 与 accept/reject 的区别正是它的用途：撤销本轮改动时，磁盘已经被写回写前状态，
   * 此时再走 accept 会把 modified 又写回去、走 reject 会写 original（对新建文件是空文件）。
   * 两者都会破坏刚做完的撤销，所以必须有一条「只清记录」的路径。
   */
  discard(id: string): void {
    this.diffs.delete(id);
  }
}

const ensuredTraceDirs = new Set<string>();
const traceBuffers = new Map<string, string[]>();
let flushTraceTimer: NodeJS.Timeout | null = null;

/**
 * 缓冲的 runId 数量上限。
 *
 * 每个 runId 都是一次 Agent 运行，而这张表**从来不清**：旧实现 flush 后只把数组
 * 清空（`lines.length = 0`），键还留着。一次会话里跑几十次 Agent，这张表就有几十个
 * 空数组；一个长年不关的窗口能积累上千个 —— 是一处稳步增长的泄漏，
 * 而它记的只是诊断日志，丢掉最老的没有任何代价。
 */
const MAX_TRACE_RUNS = 200;

function flushTraceBuffers(userDataPath: string): void {
  flushTraceTimer = null;
  const dir = path.join(userDataPath, 'traces');
  if (!ensuredTraceDirs.has(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      ensuredTraceDirs.add(dir);
    } catch {}
  }
  for (const [runId, lines] of traceBuffers.entries()) {
    if (lines.length === 0) {
      // 已经落盘的键要及时摘掉，别让它永远留在表里
      traceBuffers.delete(runId);
      continue;
    }
    const content = lines.join('');
    // 先删后写：appendFile 是异步的，写失败时这几行日志丢失是可接受的
    // （它只是排查用的 trace），但不能因此把内容永远留在内存里反复重发。
    traceBuffers.delete(runId);
    const targetFile = path.join(dir, `${runId}.log`);
    fs.appendFile(targetFile, content, 'utf8', () => {});
  }
}

export function appendRunTrace(userDataPath: string, runId: string, line: string): void {
  let list = traceBuffers.get(runId);
  if (!list) {
    if (traceBuffers.size >= MAX_TRACE_RUNS) {
      // Map 的迭代顺序是插入顺序，第一个键就是最老的
      const oldest = traceBuffers.keys().next();
      if (!oldest.done) traceBuffers.delete(oldest.value);
    }
    list = [];
    traceBuffers.set(runId, list);
  }
  list.push(`${new Date().toISOString()} ${line}\n`);
  if (!flushTraceTimer) {
    flushTraceTimer = setTimeout(() => flushTraceBuffers(userDataPath), 200);
  }
}

export type WindowGetter = () => BrowserWindow | null;
