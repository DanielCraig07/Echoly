/**
 * 远端 Agent 任务的编排层（IDE 侧）。
 *
 * 它把「远端主机」抽象成一个只有三个方法的 `RemoteTransport`：
 * 跑一条命令、上传一个文件、读一个文件。**这个抽象不是为了好看**，
 * 而是因为 SSH 那一段在本机没法端到端验证（起不了 sshd），而后面的编排逻辑
 * ——准备、上传、投递、增量读取、取消、状态推断——全部是被这一步串起来的。
 * 把传输抽走之后，这些逻辑可以用一个「模拟的远端主机」完整测到；
 * 剩下真正没测到的就只有 ssh2 的适配（十几行直译）。
 *
 * 两条贯穿始终的规矩：
 *
 * 1. **远端是唯一真相。** 本地记录只是缓存（供列表展示与断线时兜底），
 *    每次刷新都以远端的 meta 与事件日志为准。反过来（信本地）会让「远端已经跑完、
 *    界面还显示在跑」这种不一致一直挂着。
 * 2. **凭据只在必要时刻出现。** 模型 apiKey 只写进该任务的 config 文件（0600），
 *    并且任务结束时**主动删掉它** —— 凭据在远端多留一秒，就多一秒被别的东西读到的机会。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  BackgroundJobEntry,
  RemoteRunnerConfig,
  RemoteRunnerEvent,
  RemoteRunnerJob,
} from '@deepseek-ide/shared';
import {
  MIN_REMOTE_NODE_MAJOR,
  START_GRACE_MS,
  buildCancelCommand,
  buildLaunchCommand,
  buildLaunchScript,
  buildPidAliveCommand,
  buildPrepareCommand,
  buildProbeCommand,
  buildReadMetaCommand,
  buildRemoveJobCommand,
  buildTailEventsCommand,
  deriveRemoteStatus,
  isRemoteTerminal,
  parseEventOutput,
  parseMeta,
  parsePidAliveOutput,
  parseProbeOutput,
  remotePaths,
  shellQuote,
  type RemoteProbeResult,
} from './protocol';

export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 「一台 SSH 主机」的最小能力集。ssh2 的适配在 sshRemoteTransport.ts。 */
export interface RemoteTransport {
  exec(command: string, timeoutMs?: number): Promise<RemoteExecResult>;
  upload(remotePath: string, content: string, opts?: { mode?: number }): Promise<void>;
  read(remotePath: string): Promise<string | null>;
}

export interface RunnerBundle {
  content: string;
  sha256: string;
  version: string;
}

export interface RemoteAgentServiceOptions {
  transport: RemoteTransport;
  /** 读取打包好的 runner（注入是为了测试里不必先跑一次打包） */
  loadBundle: () => RunnerBundle;
  /** 本地任务记录的落盘位置。传 null 表示只放内存（测试用）。 */
  storePath?: string | null;
  now?: () => number;
  /** 每次任务状态变化时通知宿主（用于推给界面） */
  onJobUpdate?: (job: RemoteRunnerJob) => void;
  /** runner 上传与否的判断需要它：远端 sha 与本地 sha 不一致就重传 */
  runnerVersion?: string;
}

/** 时间线保留上限，与本地后台任务一致。 */
const MAX_TRANSCRIPT = 200;

export interface RemoteSubmitInput {
  prompt: string;
  /** 远端工作目录（绝对路径） */
  workspace: string;
  model: { baseUrl: string; model: string; apiKey?: string; provider?: string };
  /**
   * 无人值守。**默认 false**：远端没有人能回答确认，默认放行等于把权限模型绕过去。
   * 开着它，等于用户明确接受了「这台机器上的改动不需要我点头」。
   */
  unattended?: boolean;
  rulesText?: string;
  skillsText?: string;
  maxSteps?: number;
  hostLabel?: string;
}

interface StoredJob {
  job: RemoteRunnerJob;
  launchedAt: number;
  /** 远端家目录（SFTP 用），probe 之后缓存 */
  home?: string;
}

/** 把 AgentEvent 压成一行时间线，与本地后台任务同一套展示形态。 */
function toTranscriptEntry(
  event: RemoteRunnerEvent['event'],
  at: number,
): BackgroundJobEntry | null {
  switch (event.type) {
    case 'assistant_message':
      return event.content?.trim()
        ? { at, kind: 'text', text: event.content.replace(/\s+/g, ' ').trim().slice(0, 120) }
        : null;
    case 'tool_result':
      return { at, kind: 'tool', text: `${event.name}${event.isError ? '（失败）' : ''}` };
    case 'pending_diff':
      return { at, kind: 'text', text: `提出改动：${event.diff.path}` };
    case 'error':
      return { at, kind: 'status', text: `错误：${event.message.slice(0, 120)}` };
    case 'done':
      return { at, kind: 'status', text: event.finalText === '(cancelled)' ? '已取消' : '已完成' };
    default:
      return null;
  }
}

export class RemoteAgentService {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly now: () => number;

  constructor(private readonly options: RemoteAgentServiceOptions) {
    this.now = options.now ?? Date.now;
    this.load();
  }

  // ── 本地记录（缓存） ───────────────────────────────────────────────────────

  private load(): void {
    const storePath = this.options.storePath;
    if (!storePath) return;
    try {
      const raw = fs.readFileSync(storePath, 'utf8');
      const parsed = JSON.parse(raw) as { jobs?: StoredJob[] };
      for (const entry of parsed.jobs ?? []) {
        if (entry?.job?.jobId) this.jobs.set(entry.job.jobId, entry);
      }
    } catch {
      // 记录读不出来只是丢掉列表，不影响远端任何东西
    }
  }

  private persist(): void {
    const storePath = this.options.storePath;
    if (!storePath) return;
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2),
        'utf8',
      );
    } catch {
      // 同上：记不住不影响远端任务本身
    }
  }

  private update(job: RemoteRunnerJob, extra?: Partial<StoredJob>): RemoteRunnerJob {
    const existing = this.jobs.get(job.jobId);
    const next: StoredJob = {
      ...existing,
      ...extra,
      job,
      launchedAt: existing?.launchedAt ?? this.now(),
    };
    this.jobs.set(job.jobId, next);
    this.persist();
    this.options.onJobUpdate?.(job);
    return job;
  }

  list(): RemoteRunnerJob[] {
    return [...this.jobs.values()]
      .map((entry) => entry.job)
      .sort(
        (a, b) =>
          Number(isRemoteTerminal(a.status)) - Number(isRemoteTerminal(b.status)) ||
          b.startedAt - a.startedAt,
      );
  }

  get(jobId: string): RemoteRunnerJob | null {
    return this.jobs.get(jobId)?.job ?? null;
  }

  // ── 远端能力体检与 runner 分发 ─────────────────────────────────────────────

  async probe(): Promise<RemoteProbeResult & { ok: boolean; reason?: string }> {
    const result = await this.options.transport.exec(buildProbeCommand());
    const parsed = parseProbeOutput(result.stdout);
    if (parsed.nodeMissing) {
      return { ...parsed, ok: false, reason: '远端主机上没有找到 node' };
    }
    if (parsed.nodeMajor !== undefined && parsed.nodeMajor < MIN_REMOTE_NODE_MAJOR) {
      return {
        ...parsed,
        ok: false,
        reason: `远端 node 版本过低（${parsed.nodeVersion}），需要 v${MIN_REMOTE_NODE_MAJOR} 或更高`,
      };
    }
    if (!parsed.home) {
      return { ...parsed, ok: false, reason: '远端没能给出家目录（$HOME 为空）' };
    }
    return { ...parsed, ok: true };
  }

  /**
   * 确保远端那份 runner 与本地这份**同一版本**。
   *
   * 比对 sha 而不是「存在就不传」：runner 是会随 IDE 一起升级的，版本不一致时
   * 跑的是旧协议，字段缺失这类错最难查。sha 比不了（远端既没有 sha256sum 也没有 shasum）
   * 就退化成「版本号不同才重传」。
   */
  private async ensureRunner(home: string, probe: RemoteProbeResult): Promise<void> {
    const bundle = this.options.loadBundle();
    if (probe.runnerSha && probe.runnerSha === bundle.sha256) return;
    const paths = remotePaths('probe-0000', home);
    await this.options.transport.exec(
      `mkdir -p ${shellQuote(paths.root)} ${shellQuote(paths.jobsDir)}`,
    );
    await this.options.transport.upload(paths.runner, bundle.content, { mode: 0o700 });
  }

  // ── 投递 ───────────────────────────────────────────────────────────────────

  async submit(input: RemoteSubmitInput): Promise<RemoteRunnerJob> {
    const probe = await this.probe();
    if (!probe.ok || !probe.home) throw new Error(probe.reason ?? '远端环境不满足运行条件');
    const home = probe.home;
    await this.ensureRunner(home, probe);

    const jobId = randomUUID();
    const paths = remotePaths(jobId, home);
    const unattended = input.unattended === true;
    const config: RemoteRunnerConfig = {
      jobId,
      workspace: input.workspace,
      prompt: input.prompt,
      model: input.model,
      unattended,
      rulesText: input.rulesText,
      skillsText: input.skillsText,
      maxSteps: input.maxSteps,
    };

    const startedAt = this.now();
    const job: RemoteRunnerJob = {
      jobId,
      hostLabel: input.hostLabel ?? 'ssh',
      workspace: input.workspace,
      title:
        input.prompt
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.slice(0, 80) ?? '(未命名任务)',
      status: 'starting',
      startedAt,
      sequence: 0,
      // 只有真的带上了 key 才算「带走了凭据」，空 key 说明远端自己从环境变量拿
      sentCredentials: Boolean(input.model.apiKey),
      transcript: [],
    };

    // 顺序不能换：先清残留（否则同一 jobId 会读到上一轮事件，而 jobId 是新的，风险低但代价也低）、
    // 再传 config（0600）与启动脚本，最后才启动。少了任何一步，runner 都会在远端报「缺文件」。
    await this.options.transport.exec(buildPrepareCommand(jobId));
    await this.options.transport.upload(paths.config, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
    await this.options.transport.upload(paths.launch, buildLaunchScript(jobId, input.workspace), {
      mode: 0o700,
    });

    this.update(job, { launchedAt: startedAt, home });

    const launch = await this.options.transport.exec(buildLaunchCommand(jobId));
    if (launch.code !== 0 || launch.stderr.trim()) {
      // 启动脚本自己会打 ECHOLY_LAUNCH_* 标记；原样带出去，别吞成一句「启动失败」
      const detail = [launch.stderr.trim(), `退出码 ${launch.code}`].filter(Boolean).join('；');
      return this.update({
        ...job,
        status: 'error',
        error: `启动失败：${detail}`,
        finishedAt: this.now(),
      });
    }
    return job;
  }

  // ── 刷新（读回远端状态） ───────────────────────────────────────────────────

  /**
   * 增量拉一次远端状态。
   *
   * 已经终了的任务不再打远端 —— 结果不会变，而每轮多打几次命令在慢链路上很贵。
   */
  async refresh(jobId: string): Promise<RemoteRunnerJob | null> {
    const stored = this.jobs.get(jobId);
    if (!stored) return null;
    const job = stored.job;
    const home = stored.home;
    if (!home) return job;
    if (isRemoteTerminal(job.status) && job.status !== 'lost') return job;

    const paths = remotePaths(jobId, home);
    const metaRaw =
      (await this.options.transport.read(paths.meta)) ??
      (await this.options.transport.exec(buildReadMetaCommand(jobId))).stdout;
    const meta = parseMeta(metaRaw);

    let pidAlive: boolean | null = null;
    if (meta?.status === 'running' && meta.pid > 0) {
      const alive = await this.options.transport.exec(buildPidAliveCommand(meta.pid));
      pidAlive = parsePidAliveOutput(alive.stdout);
    }

    const status = deriveRemoteStatus({
      meta,
      pidAlive,
      launchedAt: stored.launchedAt,
      now: this.now(),
    });

    // 事件永远按 seq 续读：重连、重开界面都走同一条路
    const tail = await this.options.transport.exec(buildTailEventsCommand(jobId, job.sequence));
    const events = parseEventOutput(tail.stdout);
    let transcript = job.transcript ?? [];
    let summary = job.summary;
    for (const entry of events) {
      const line = toTranscriptEntry(entry.event, entry.at);
      if (line) transcript = [...transcript, line].slice(-MAX_TRANSCRIPT);
      if (entry.event.type === 'assistant_message' && entry.event.content?.trim()) {
        const flat = entry.event.content.replace(/\s+/g, ' ').trim();
        summary = flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
      }
    }
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : job.sequence;

    const next: RemoteRunnerJob = {
      ...job,
      status,
      sequence: Math.max(job.sequence, lastSeq),
      transcript,
      summary: meta?.summary ?? summary,
      error: meta?.error ?? job.error,
      pid: meta?.pid ?? job.pid,
      finishedAt: meta?.finishedAt ?? (isRemoteTerminal(status) ? this.now() : job.finishedAt),
    };

    if (isRemoteTerminal(status) && !isRemoteTerminal(job.status)) {
      // 任务刚结束：凭据文件不再需要，主动删掉，别让它在远端继续躺着
      await this.dropCredentials(jobId, home);
    }
    return this.update(next, { home });
  }

  /**
   * 删掉远端那份 config（内含模型凭据）。
   *
   * 任务结束后它没有任何用处，而它躺在远端磁盘上就是一份可被读取的凭据。
   * 失败不抛错：删不掉不该让「任务已完成」这件事看起来失败了，
   * 但要留下痕迹 —— 界面上靠 sentCredentials 提示用户手工清理。
   */
  private async dropCredentials(jobId: string, home: string): Promise<void> {
    try {
      const paths = remotePaths(jobId, home);
      await this.options.transport.exec(`rm -f ${shellQuote(paths.config)}`);
    } catch {
      // 见上
    }
  }

  // ── 取消与清理 ─────────────────────────────────────────────────────────────

  async cancel(jobId: string): Promise<RemoteRunnerJob | null> {
    const stored = this.jobs.get(jobId);
    if (!stored) return null;
    const home = stored.home;
    if (!home) return stored.job;
    // 先落标记、再发信号（顺序由 protocol 保证）：只发信号的话远端可能什么都记不下来
    await this.options.transport.exec(buildCancelCommand(jobId, stored.job.pid));
    const next: RemoteRunnerJob = { ...stored.job, status: 'cancelled', finishedAt: this.now() };
    return this.update(next, { home });
  }

  async remove(jobId: string): Promise<boolean> {
    const stored = this.jobs.get(jobId);
    if (!stored) return false;
    if (stored.home) {
      try {
        await this.options.transport.exec(buildRemoveJobCommand(jobId));
      } catch {
        // 远端清理失败也要把本地记录摘掉，否则界面上会留下一条永远删不掉的条目
      }
    }
    this.jobs.delete(jobId);
    this.persist();
    return true;
  }

  /** 只有这些是「看着还在跑但其实已经没人管」的兜底判断，供宿主定期调用。 */
  async refreshAll(): Promise<RemoteRunnerJob[]> {
    for (const jobId of [...this.jobs.keys()]) {
      try {
        await this.refresh(jobId);
      } catch {
        // 单条刷不出来不该拖垮整轮刷新（SSH 断线时每条都会失败）
      }
    }
    return this.list();
  }

  /** 远端最后一条事件的时间；用于给「启动宽限期」一个真实的起点。 */
  static graceMs(): number {
    return START_GRACE_MS;
  }
}
