/**
 * 远端 Agent runner 的协议层（IDE 侧）。
 *
 * 这一层只做一件事：把「要在远端主机上跑的几条命令」和「从远端读回来的几个文件」
 * 变成纯字符串/纯对象。**不碰 ssh、不碰 fs** —— 因为这里最容易出的两类错都极难在
 * 真机上定位：
 *
 * 1. **命令注入**。工作目录、提示词里的中文与引号，最终都要拼进一条 shell 命令。
 *    拼错一次的后果是在用户的服务器上执行任意命令。所以拼接一律走 `shellQuote`，
 *    并有专门的测试拿恶意串去撞它。
 * 2. **增量读回的边界**。事件日志只追加，第 N 行就是第 N 条事件 —— 依赖这个不变式
 *    才能用 `tail -n +K` 断线续读。不变式一旦被破坏（例如中间写了半行），症状是
 *    「重连后事件错位」，而错位不报错，只会让界面显示得莫名其妙。
 *
 * 关于路径：`remotePaths()` 返回的是**未加引号的 shell 表达式**（含 `$HOME`），
 * 由调用方在拼命令时用双引号包住。之所以允许 `$HOME` 留到这里而不是在本地展开：
 * 远端主机的家目录只有远端自己知道，本地猜错会指向一个不存在的目录，
 * 而那种失败看起来像「runner 没装上」。
 */

import type { RemoteRunnerEvent, RemoteRunnerMeta, RemoteRunnerStatus } from '@deepseek-ide/shared';

/**
 * 协议版本。
 *
 * IDE 与 runner 是分别更新的两份东西（runner 只是被拷到远端的一个文件），
 * 所以必须能识别出「远端那份是旧的」：版本不一致就重新上传，而不是拿旧 runner
 * 跑新协议 —— 那会变成字段缺失这种最难查的错。
 */
export const REMOTE_RUNNER_VERSION = '1';

/** 远端 runner 的最低 Node 版本。 */
export const MIN_REMOTE_NODE_MAJOR = 20;

/** 远端 runner 目录（相对远端家目录）。 */
const REMOTE_ROOT = '$HOME/.echoly/runner';

/** 启动宽限期：这段时间内还没见到 meta 属正常（正在起），不算失败。 */
export const START_GRACE_MS = 20_000;

export interface RemotePaths {
  root: string;
  runner: string;
  jobsDir: string;
  meta: string;
  events: string;
  config: string;
  cancel: string;
  log: string;
  launch: string;
}

/**
 * jobId 的合法形状。
 *
 * 它是**唯一被直接拼进文件名**的远端可控输入（IDE 也会从远端列目录读回 jobId），
 * 所以这里是安全边界：不合格的直接拒绝，而不是「清理一下再用」。
 * 只允许十六进制与小写字母与连字符，不含点、斜杠、引号 —— 拼不出 `../`。
 */
const SAFE_JOB_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function isSafeJobId(jobId: string): boolean {
  return SAFE_JOB_ID.test(jobId);
}

export function assertSafeJobId(jobId: string): void {
  if (!isSafeJobId(jobId)) throw new Error(`非法的 jobId：${JSON.stringify(jobId)}`);
}

/** 远端各项文件的路径（未加引号的 shell 表达式，见文件头说明）。 */
export function remotePaths(jobId: string): RemotePaths {
  assertSafeJobId(jobId);
  const jobs = `${REMOTE_ROOT}/jobs`;
  return {
    root: REMOTE_ROOT,
    runner: `${REMOTE_ROOT}/echoly-runner.mjs`,
    jobsDir: jobs,
    meta: `${jobs}/${jobId}.meta.json`,
    events: `${jobs}/${jobId}.jsonl`,
    config: `${jobs}/${jobId}.config.json`,
    cancel: `${jobs}/${jobId}.cancel`,
    log: `${jobs}/${jobId}.log`,
    launch: `${jobs}/${jobId}.launch.sh`,
  };
}

/** 包成 shell 双引号形式（允许 `$HOME` 展开）。 */
export function quoted(pathExpr: string): string {
  if (pathExpr.includes('"')) throw new Error(`路径表达式中不允许出现双引号：${pathExpr}`);
  return `"${pathExpr}"`;
}

/**
 * POSIX shell 的单引号转义。
 *
 * 单引号内除了单引号本身没有任何字符有特殊含义，所以唯一的处理是把 `'` 变成
 * 结束引用 + 转义单引号 + 重新开始引用。这是唯一能对任意字节都成立的转义方式：
 * 双引号做不到 —— `$`、反引号、反斜杠、`!` 在里面都还有含义。
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** 远端体检：Node 在不在、版本多少、runner 是不是同一份（比 sha）。 */
export function buildProbeCommand(): string {
  const runner = quoted(remotePaths('probe-0000').runner);
  return [
    'command -v node >/dev/null 2>&1 || { echo ECHOLY_NODE_MISSING; exit 0; }',
    'echo "NODE_VERSION=$(node -v 2>/dev/null)"',
    `if [ -f ${runner} ]; then echo "RUNNER_SHA=$( (sha256sum ${runner} 2>/dev/null || shasum -a 256 ${runner} 2>/dev/null) | awk '{print $1}' )"; else echo "RUNNER_SHA="; fi`,
  ].join('; ');
}

export interface RemoteProbeResult {
  nodeMissing: boolean;
  nodeVersion?: string;
  nodeMajor?: number;
  runnerSha?: string;
}

/** 解析体检输出。容忍缺行 —— 远端 shell 打点别的噪音不该让体检整体失败。 */
export function parseProbeOutput(stdout: string): RemoteProbeResult {
  if (stdout.includes('ECHOLY_NODE_MISSING')) return { nodeMissing: true };
  const versionLine = stdout.match(/NODE_VERSION=(\S+)/);
  const shaLine = stdout.match(/RUNNER_SHA=([0-9a-fA-F]*)/);
  const nodeVersion = versionLine?.[1];
  const major = nodeVersion
    ? Number.parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10)
    : NaN;
  return {
    nodeMissing: false,
    nodeVersion,
    nodeMajor: Number.isFinite(major) ? major : undefined,
    runnerSha: shaLine?.[1] || undefined,
  };
}

/** 建目录并清掉同名旧任务的残留（重跑同一个 jobId 必须清，否则会读到上一轮的事件）。 */
export function buildPrepareCommand(jobId: string): string {
  const p = remotePaths(jobId);
  return [
    `mkdir -p ${quoted(p.jobsDir)}`,
    `chmod 700 ${quoted(p.root)} ${quoted(p.jobsDir)} 2>/dev/null || true`,
    `rm -f ${quoted(p.meta)} ${quoted(p.events)} ${quoted(p.cancel)} ${quoted(p.log)}`,
  ].join(' && ');
}

/**
 * 启动脚本的正文。
 *
 * 不把启动逻辑直接拼进 SSH 命令，是因为那里面要写 `cd` / `nohup` / 重定向，
 * 嵌在一层引号里再嵌一层，出错形态是「命令在远端被截断」，很难在本地看出来。
 * 先落一个脚本文件、再 `sh` 它，复杂部分就只有一层引号。
 */
export function buildLaunchScript(jobId: string, workspace: string): string {
  const p = remotePaths(jobId);
  // 脚本内部用双引号，`$HOME` 才能展开；workspace 是用户数据，必须单引号
  const lines = [
    '#!/bin/sh',
    '# 由 Echoly 生成。作用只有一个：把 agent runner 从 SSH 会话里解绑，',
    '# 这样窗口关掉、SSH 断开之后它仍然在跑（nohup 让它忽略 SIGHUP）。',
    `RUNNER="${p.runner}"`,
    `CONFIG="${p.config}"`,
    `LOG="${p.log}"`,
    `cd ${shellQuote(workspace)} || { echo "ECHOLY_LAUNCH_WORKSPACE_MISSING" >&2; exit 3; }`,
    '[ -f "$RUNNER" ] || { echo "ECHOLY_LAUNCH_RUNNER_MISSING" >&2; exit 4; }',
    '[ -f "$CONFIG" ] || { echo "ECHOLY_LAUNCH_CONFIG_MISSING" >&2; exit 5; }',
    'nohup node "$RUNNER" --config "$CONFIG" </dev/null >>"$LOG" 2>&1 &',
    'exit 0',
    '',
  ];
  return lines.join('\n');
}

/** 跑启动脚本。用双引号让 `$HOME` 展开；脚本路径只由受校验的 jobId 拼成。 */
export function buildLaunchCommand(jobId: string): string {
  return `sh ${quoted(remotePaths(jobId).launch)}`;
}

/** 读 meta 文件。文件可能还没写出来，所以缺文件要给一个可识别的空结果。 */
export function buildReadMetaCommand(jobId: string): string {
  const meta = quoted(remotePaths(jobId).meta);
  return `if [ -f ${meta} ]; then cat ${meta}; else echo ECHOLY_NO_META; fi`;
}

/**
 * 增量读事件日志。
 *
 * 靠的是「第 N 行 == 第 seq 条」这个不变式，于是续读退化成 `tail -n +K` ——
 * 远端不需要做任何解析，也就不需要在远端装 jq 之类的东西。
 */
export function buildTailEventsCommand(jobId: string, fromSeq: number): string {
  const from = Math.max(0, Math.floor(fromSeq)) + 1;
  const events = quoted(remotePaths(jobId).events);
  return `if [ -f ${events} ]; then tail -n +${from} ${events}; fi`;
}

/** 进程还活着吗。pid 一定是整数（由我们从 meta 读回并校验）。 */
export function buildPidAliveCommand(pid: number): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`非法的 pid：${pid}`);
  return `kill -0 ${pid} 2>/dev/null && echo ECHOLY_ALIVE || echo ECHOLY_DEAD`;
}

export function parsePidAliveOutput(stdout: string): boolean | null {
  if (stdout.includes('ECHOLY_ALIVE')) return true;
  if (stdout.includes('ECHOLY_DEAD')) return false;
  return null;
}

/**
 * 取消一个远端任务。
 *
 * 先落 cancel 标记再发信号：标记让 runner 在下一个步骤边界自己停下来（能写完 meta
 * 与收尾摘要），信号则兜住「runner 正卡在一次模型请求里」的情形。
 * 只发信号的话，用户看到的是「已取消」但远端什么都没记下来。
 */
export function buildCancelCommand(jobId: string, pid?: number): string {
  const p = remotePaths(jobId);
  const parts = [`touch ${quoted(p.cancel)}`];
  if (pid !== undefined) parts.push(`kill -TERM ${pid} 2>/dev/null || true`);
  return parts.join(' && ');
}

/** 删掉一个任务的全部文件（用户在界面上清理时）。 */
export function buildRemoveJobCommand(jobId: string): string {
  const p = remotePaths(jobId);
  return `rm -f ${quoted(p.meta)} ${quoted(p.events)} ${quoted(p.config)} ${quoted(p.cancel)} ${quoted(p.log)} ${quoted(p.launch)}`;
}

// ── 读回内容的解析 ──────────────────────────────────────────────────────────

export function parseMeta(raw: string | null | undefined): RemoteRunnerMeta | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text || text.includes('ECHOLY_NO_META')) return null;
  try {
    const parsed = JSON.parse(text) as Partial<RemoteRunnerMeta>;
    if (typeof parsed?.jobId !== 'string' || typeof parsed?.status !== 'string') return null;
    return {
      jobId: parsed.jobId,
      pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      status: parsed.status as RemoteRunnerMeta['status'],
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace : '',
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      finishedAt: typeof parsed.finishedAt === 'number' ? parsed.finishedAt : undefined,
      sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      runnerVersion: typeof parsed.runnerVersion === 'string' ? parsed.runnerVersion : '',
      nodeVersion: typeof parsed.nodeVersion === 'string' ? parsed.nodeVersion : undefined,
    };
  } catch {
    // 写了一半就被读走（runner 正在写）→ 这一轮当没读到，下次再读
    return null;
  }
}

/**
 * 解析一行事件日志。
 *
 * 末行可能是半行（runner 正在写），所以调用方应当先丢掉最后一个不完整的行。
 * 这里对单行只做「不是完整 JSON 就返回 null」，不抛错。
 */
export function parseEventLine(line: string): RemoteRunnerEvent | null {
  const text = line.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<RemoteRunnerEvent>;
    if (typeof parsed?.seq !== 'number' || !parsed.event) return null;
    return {
      seq: parsed.seq,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
      event: parsed.event,
    };
  } catch {
    return null;
  }
}

/** 把 tail 的输出切成事件数组，丢掉不完整的末行与坏行。 */
export function parseEventOutput(stdout: string): RemoteRunnerEvent[] {
  if (!stdout) return [];
  const lines = stdout.split('\n');
  // 输出不以换行结尾说明最后一行还没写完 —— 丢掉，下一轮会连同后续内容一起读到
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.pop();
  const out: RemoteRunnerEvent[] = [];
  for (const line of lines) {
    const parsed = parseEventLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface DeriveStatusInput {
  meta: RemoteRunnerMeta | null;
  /** 远端 `kill -0` 的结果；没查到传 null */
  pidAlive: boolean | null;
  /** 本地投递出去的时间 */
  launchedAt: number;
  now?: number;
  startGraceMs?: number;
}

/**
 * 由远端状态推出界面上该显示什么。
 *
 * 最要紧的一格是 `lost`：进程没了、也没留下终态。它**必须**与「还在跑」区分开 ——
 * 显示成「运行中」会让用户一直等一个已经死掉的任务，而不会去看远端日志。
 */
export function deriveRemoteStatus(input: DeriveStatusInput): RemoteRunnerStatus {
  const now = input.now ?? Date.now();
  const grace = input.startGraceMs ?? START_GRACE_MS;
  const { meta, pidAlive } = input;

  if (meta) {
    if (meta.status !== 'running') return meta.status;
    // meta 说在跑，但进程已经不在了 —— 被信号杀掉之类
    if (pidAlive === false) return 'lost';
    return 'running';
  }
  // 还没写出 meta：宽限期内算「正在启动」
  return now - input.launchedAt < grace ? 'starting' : 'lost';
}

export function isRemoteTerminal(status: RemoteRunnerStatus): boolean {
  return status !== 'starting' && status !== 'running';
}

/** 由事件流抽出收尾摘要（最后一条 assistant_message 或 error），供列表展示。 */
export function summaryFromEvents(events: readonly RemoteRunnerEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i].event;
    if (event.type === 'assistant_message' && event.content?.trim()) {
      const flat = event.content.replace(/\s+/g, ' ').trim();
      return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
    }
    if (event.type === 'error') return event.message;
  }
  return undefined;
}
