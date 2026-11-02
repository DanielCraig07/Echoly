/**
 * 后台 Agent 任务的登记与持久化。
 *
 * 为什么要落盘：后台任务的意义就是「发出去之后切走」。那么用户回来时
 * （甚至**重启应用之后**）必须还能看到「刚才那件事跑完没有、结果是什么」。
 * 只放内存的话，唯一能证明它跑过的就是当时那块界面，窗口一关就无迹可寻 ——
 * 那这个功能就等于不存在。
 *
 * 这里刻意把「纯逻辑」与「读写盘」分开：摘要、时间线裁剪、清理、状态收敛
 * 全是普通函数，可以脱离 Electron 单测；只有 `BackgroundJobStore` 会碰文件系统。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import electronLog from 'electron-log';
import type { BackgroundJob, BackgroundJobEntry, BackgroundJobStatus } from '@deepseek-ide/shared';

/** 记录上限。只留最近若干条：这是一份「最近发生过什么」的清单，不是审计日志。 */
export const MAX_JOBS = 30;
/** 单个任务时间线的上限。超过就丢最早的 —— 尾部（结论、报错）才是要回看的部分。 */
export const MAX_TRANSCRIPT = 200;
/** 已结束任务的保留时长。 */
export const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;
/** 收尾摘要长度。 */
export const SUMMARY_MAX = 200;

export function isFinished(status: BackgroundJobStatus): boolean {
  return status !== 'running';
}

/**
 * 由提示词生成任务标题：只看第一行、压掉多余空白。
 *
 * 取第一行是因为用户常常先写一句「要做什么」，后面才是长段落；而列表里一行就够辨认。
 */
export function summarizePrompt(prompt: string, max = 80): string {
  const firstLine = (prompt ?? '').split(/\r?\n/).find((line) => line.trim()) ?? '';
  const text = firstLine.replace(/\s+/g, ' ').trim();
  if (!text) return '(未命名任务)';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** 收尾摘要：把换行压平、截断。 */
export function summarizeText(text: string, max = SUMMARY_MAX): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * 往时间线追加一条，并裁剪到上限。
 *
 * 裁剪**从头部**丢：后台任务通常跑很久，用户回来看的是「最后怎么样了」，
 * 早期步骤被丢掉远比丢掉结论可接受。
 */
export function appendEntry(
  transcript: readonly BackgroundJobEntry[],
  entry: BackgroundJobEntry,
  cap = MAX_TRANSCRIPT,
): BackgroundJobEntry[] {
  const next = [...transcript, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * 把任务收敛到某个终态。
 *
 * **只有 `running` 能被终结**：`done` 与 `error` 事件在异常路径上可能都会到
 * （例如 runAgent 内部抛错后外层又补发 done），后到的不该把已经写好的结论覆盖掉。
 */
export function finalizeJob(
  job: BackgroundJob,
  status: Exclude<BackgroundJobStatus, 'running'>,
  patch: { summary?: string; error?: string } = {},
  now = Date.now(),
): BackgroundJob {
  if (isFinished(job.status)) return job;
  return {
    ...job,
    status,
    endedAt: now,
    summary: patch.summary ?? job.summary,
    error: patch.error ?? job.error,
  };
}

/**
 * 清理：先按数量截断，再丢掉过期的已结束任务。
 *
 * 运行中的任务**永远保留**：它还在跑，丢掉记录就再也没法从界面点回去看它。
 * 排序规则是「运行中的在前，其余按开始时间新→旧」，列表与截断共用这一个顺序。
 */
export function pruneJobs(
  jobs: readonly BackgroundJob[],
  now = Date.now(),
  opts: { max?: number; ttlMs?: number } = {},
): BackgroundJob[] {
  const max = opts.max ?? MAX_JOBS;
  const ttlMs = opts.ttlMs ?? FINISHED_TTL_MS;
  const ordered = [...jobs].sort(
    (a, b) =>
      Number(isFinished(a.status)) - Number(isFinished(b.status)) || b.startedAt - a.startedAt,
  );
  const kept = ordered.filter(
    (job) => !isFinished(job.status) || now - (job.endedAt ?? job.startedAt) <= ttlMs,
  );
  return kept.slice(0, max);
}

/** 把任意输入收敛成合法的任务列表（磁盘文件可能被手工改坏）。 */
export function normalizeJobs(input: unknown): BackgroundJob[] {
  if (!Array.isArray(input)) return [];
  const out: BackgroundJob[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const job = raw as Partial<BackgroundJob>;
    if (typeof job.id !== 'string' || !job.id) continue;
    const status: BackgroundJobStatus =
      job.status === 'done' || job.status === 'error' || job.status === 'cancelled'
        ? job.status
        : 'running';
    out.push({
      id: job.id,
      title: typeof job.title === 'string' && job.title ? job.title : '(未命名任务)',
      status,
      workspaceLabel: typeof job.workspaceLabel === 'string' ? job.workspaceLabel : undefined,
      startedAt: typeof job.startedAt === 'number' ? job.startedAt : Date.now(),
      endedAt: typeof job.endedAt === 'number' ? job.endedAt : undefined,
      summary: typeof job.summary === 'string' ? job.summary : undefined,
      error: typeof job.error === 'string' ? job.error : undefined,
      transcript: Array.isArray(job.transcript)
        ? job.transcript.filter(
            (e): e is BackgroundJobEntry =>
              !!e && typeof e === 'object' && typeof (e as BackgroundJobEntry).text === 'string',
          )
        : [],
    });
  }
  return out;
}

/**
 * 落盘的登记簿。
 *
 * 写盘走「尽力而为」：记不住任务记录只影响历史回看，绝不该影响任务本身跑不跑，
 * 所以所有 IO 错误都吞掉并留一条 warn。
 */
export class BackgroundJobStore {
  private jobs: BackgroundJob[] = [];
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      // 上次进程被杀时可能留下 running 状态：重启后没有谁在跑它了，
      // 留着会显示一个永远转圈的任务，所以统一收成 cancelled。
      this.jobs = normalizeJobs(JSON.parse(raw)).map((job) =>
        job.status === 'running'
          ? {
              ...job,
              status: 'cancelled',
              endedAt: job.endedAt ?? Date.now(),
              summary: job.summary ?? '应用已退出，任务未完成',
            }
          : job,
      );
    } catch {
      this.jobs = [];
    }
    this.loaded = true;
  }

  list(): BackgroundJob[] {
    return pruneJobs(this.jobs);
  }

  get(id: string): BackgroundJob | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  /** 新建或整体替换一条记录。 */
  async upsert(job: BackgroundJob): Promise<BackgroundJob[]> {
    const index = this.jobs.findIndex((j) => j.id === job.id);
    if (index >= 0) this.jobs[index] = job;
    else this.jobs.push(job);
    this.jobs = pruneJobs(this.jobs);
    await this.persist();
    return this.list();
  }

  async clearFinished(): Promise<BackgroundJob[]> {
    this.jobs = this.jobs.filter((job) => !isFinished(job.status));
    await this.persist();
    return this.list();
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.jobs, null, 2), 'utf8');
    } catch (err) {
      electronLog.warn('[backgroundJobs] 写入失败（不影响任务本身）:', err);
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}
