/**
 * 任务日志：meta 文件 + 事件日志 + 取消标记。
 *
 * 三件事写在一起的唯一理由，是它们必须**互相一致**：读侧（IDE）靠「第 N 行 == 第 seq 条」
 * 做增量续读，靠 meta 判断任务是不是还活着。所以这里定下两条不变式：
 *
 * 1. **事件日志只追加、永不重写。** 一旦允许重写，行号就不再等于 seq，`tail -n +K`
 *    会读到错位的内容 —— 而且不会报错，只会让界面显示得莫名其妙。
 * 2. **写入严格串行。** `append` 是 async 的，若允许并发重叠，两个 append 的
 *    「算 seq」与「落盘」之间会互相插队：seq 是 1、2，文件里可能是 2、1。
 *    这个 bug 在本地几乎测不出来（文件通常一次就写完），要到远端高延迟通道上才现形，
 *    所以这里用一个 promise 链把顺序钉死。
 *
 * meta 用「写临时文件再 rename」：读侧随时可能来读，rename 是原子的，
 * 要么读到旧的完整内容，要么读到新的完整内容，不会读到半截。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent, RemoteRunnerMeta } from '@deepseek-ide/shared';

export interface JournalPaths {
  meta: string;
  events: string;
  cancel: string;
}

export interface JournalStartInfo {
  jobId: string;
  workspace: string;
  runnerVersion: string;
  nodeVersion?: string;
  /** 进程 pid。默认取当前进程 —— 不走默认值只是为了测试可控 */
  pid?: number;
}

export class JobJournal {
  private seq = 0;
  private startedAt: number;
  /** append 的串行链。见文件头第 2 条。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: JournalPaths,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = this.now();
  }

  get sequence(): number {
    return this.seq;
  }

  get started(): number {
    return this.startedAt;
  }

  /** 取消标记存在即视为「用户要求停止」。runner 在每个步骤边界读一次。 */
  isCancelled(): boolean {
    try {
      return fs.existsSync(this.paths.cancel);
    } catch {
      return false;
    }
  }

  async start(info: JournalStartInfo): Promise<void> {
    await fsp.mkdir(path.dirname(this.paths.meta), { recursive: true });
    // **自己先把事件日志清空。**
    //
    // 不变式「第 N 行 == 第 seq 条」依赖「这一轮的事件从第 1 行开始」。IDE 侧虽然也会
    // 在投递前清理一遍，但那是**另一个进程、另一段时间**里的动作：清理没成功、或者
    // 用一个 jobId 跑了两次，seq 就会从 1 重新开始，而文件里还躺着上一轮的旧行 ——
    // IDE 按 seq 续读时会切到错误位置，显示出上一轮的内容，且**不会报错**。
    // runner 才是这个文件的主人，所以由它来保证这件事，而不是指望上游。
    //
    // 注意这里**不动** cancel 标记：如果用户恰好在投递与启动之间取消，
    // 删掉它就把那次取消吞了。宁可让 runner 立刻停下来（那是一条可见的 cancelled）。
    await fsp.writeFile(this.paths.events, '', 'utf8');
    await this.writeMeta({
      jobId: info.jobId,
      pid: info.pid ?? process.pid,
      status: 'running',
      workspace: info.workspace,
      startedAt: this.startedAt,
      sequence: 0,
      runnerVersion: info.runnerVersion,
      nodeVersion: info.nodeVersion,
    });
  }

  /**
   * 追加一条事件。
   *
   * 返回的 promise 在**这一条**落盘之后 resolve，调用方 await 它才能保证
   * 「进程退出前事件已经写出去了」。
   */
  append(event: AgentEvent): Promise<void> {
    const seq = (this.seq += 1);
    const line = `${JSON.stringify({ seq, at: this.now(), event })}\n`;
    this.queue = this.queue.then(async () => {
      // 目录可能还没有（极端情况下 start 尚未落盘）—— 补一次，避免整轮事件静默丢失
      await fsp.mkdir(path.dirname(this.paths.events), { recursive: true });
      await fsp.appendFile(this.paths.events, line, 'utf8');
    });
    return this.queue;
  }

  /**
   * 收尾：写入终态、摘要与最终 seq。
   *
   * 必须带上 `start` 时的那份 base 信息（jobId / workspace / 版本）—— meta 是整份重写的，
   * 只写终态会把 jobId 与 workspace 抹掉，而 IDE 正是靠这两个字段把远端事件流
   * 与本地那条任务记录对上。一次「收尾抹掉身份」的 bug，症状是任务永远停在「运行中」。
   */
  async finish(
    base: JournalStartInfo,
    status: Exclude<RemoteRunnerMeta['status'], 'running'>,
    patch: { error?: string; summary?: string } = {},
  ): Promise<void> {
    // 先把排队的追加写完再写终态：否则会「读到终态、却还缺最后几条事件」
    await this.queue;
    await this.writeMeta({
      jobId: base.jobId,
      pid: base.pid ?? process.pid,
      status,
      workspace: base.workspace,
      startedAt: this.startedAt,
      finishedAt: this.now(),
      sequence: this.seq,
      runnerVersion: base.runnerVersion,
      nodeVersion: base.nodeVersion,
      error: patch.error,
      summary: patch.summary,
    });
  }

  private async writeMeta(meta: RemoteRunnerMeta): Promise<void> {
    const tmp = `${this.paths.meta}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.rename(tmp, this.paths.meta);
  }
}
