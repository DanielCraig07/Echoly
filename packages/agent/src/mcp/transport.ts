import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  LineJsonRpcDecoder,
  MCP_ERROR,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './protocol.js';

/**
 * MCP 的 stdio 传输：把「一个子进程」包装成「请求 → 响应」的异步通道。
 *
 * 三件事在这里被收口，因为它们都是**用一次就错一次**的坑：
 *
 * 1. **分片**：stdout 的分片边界由操作系统决定，不由协议决定。解码交给
 *    `LineJsonRpcDecoder`，它按行缓冲，不假设一次 data 事件等于一条消息。
 * 2. **超时**：不设超时的话，一个卡死的 server 会让 Agent 的整个步骤永远停在那里，
 *    而界面上只显示「工具执行中」。超时后必须把这个待决请求从表里摘掉，
 *    否则迟到的响应会 resolve 一个已经没人等的 Promise。
 * 3. **退出**：进程一死，所有在途请求必须立刻以错误拒绝。留在表里的 Promise
 *    永远不会 resolve，表现就是「工具卡住」——比报错难查得多。
 *
 * 安全性：始终以 `shell: false` + 参数数组启动，绝不把用户配置的命令拼进 shell。
 * Windows 上 `npx`/`uvx` 是 `.cmd` 包装器，必须显式开 `shell`（配置项），
 * 此时由 `quoteWinArg` 负责加引号 —— 把这个选择权交给用户，而不是替他默认打开。
 */

/** 单条请求的默认超时。MCP 工具大多在本地跑，30 秒足够；慢工具可在 server 配置里放宽。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** stderr 保留的行数上限。诊断日志不能无限涨，它只是给用户自查用的。 */
const STDERR_BUFFER_LINES = 200;

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Windows 下启动 `.cmd` 包装器（npx/uvx）时需要。默认 false。 */
  shell?: boolean;
  requestTimeoutMs?: number;
  /** 启动后等待 initialize 响应的上限。冷启动 + npx 下载可能很慢，给得比普通请求宽。 */
  connectTimeoutMs?: number;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

export class McpTransportClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpTransportClosedError';
  }
}

/**
 * Windows 上 `shell: true` 时 Node 会把 command + args 拼成一个字符串交给 cmd.exe。
 * cmd.exe 的转义规则与 POSIX 完全不同（`^` 转义、`"` 成对），
 * 这里只做「含空格/特殊字符就整体加引号并把内部引号翻倍」这一层，
 * 足够覆盖路径带空格这种最常见的情况。
 */
function quoteWinArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

export class StdioMcpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new LineJsonRpcDecoder((line) => this.pushStderr(`[stdout 非 JSON] ${line}`));
  private pending = new Map<number | string, Pending>();
  private nextId = 1;
  private stderrLines: string[] = [];
  private closed = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  /** 服务端主动发来的通知（如 `notifications/tools/list_changed`）。 */
  private notificationHandlers = new Set<(n: JsonRpcNotification) => void>();

  constructor(private readonly options: StdioTransportOptions) {}

  get isRunning(): boolean {
    return this.child !== null && !this.closed && this.child.exitCode === null;
  }

  /** 进程退出后的退出码/信号，供错误信息引用。 */
  get exitStatus(): { code: number | null; signal: string | null } | null {
    return this.exitInfo;
  }

  onNotification(handler: (n: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /** 最近的 stderr（含被误打到 stdout 的日志），用于在界面上给出可自查的诊断。 */
  stderrTail(maxLines = 20): string {
    return this.stderrLines.slice(-maxLines).join('\n');
  }

  start(): void {
    if (this.child) return;
    const args = this.options.args ?? [];
    const useShell = this.options.shell === true;
    const command = useShell
      ? [this.options.command, ...args].map(quoteWinArg).join(' ')
      : this.options.command;

    const child = spawn(command, useShell ? [] : args, {
      cwd: this.options.cwd || undefined,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      for (const msg of this.decoder.push(chunk)) this.handleMessage(msg);
    });
    child.stderr.on('data', (chunk: string) => {
      for (const line of String(chunk).split('\n')) this.pushStderr(line);
    });

    child.on('error', (err) => {
      // ENOENT 在 Windows 上几乎总是「没有 shell:true 就启动不了 .cmd」，
      // 直接把解决办法写进错误信息，免得用户对着「spawn ENOENT」猜。
      const hint =
        process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? '（Windows 下启动 npx/uvx 这类 .cmd 包装器，需要在该服务器配置里设置 shell: true）'
          : '';
      this.failAll(new McpTransportClosedError(`启动 MCP 服务器失败：${err.message}${hint}`));
      this.closed = true;
    });

    child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      // 先把残余当成完整消息试一次：有些 server 最后一条响应没有换行符收尾
      for (const msg of this.decoder.flush()) this.handleMessage(msg);
      const detail = this.stderrTail(10);
      this.failAll(
        new McpTransportClosedError(
          `MCP 服务器已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）` +
            (detail ? `\n最近输出：\n${detail}` : ''),
        ),
      );
      this.closed = true;
      this.child = null;
    });
  }

  private pushStderr(line: string): void {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length === 0) return;
    this.stderrLines.push(trimmed);
    if (this.stderrLines.length > STDERR_BUFFER_LINES) {
      this.stderrLines.splice(0, this.stderrLines.length - STDERR_BUFFER_LINES);
    }
  }

  private handleMessage(msg: unknown): void {
    if (isJsonRpcResponse(msg)) {
      const key = msg.id as number | string;
      const entry = this.pending.get(key);
      // 找不到待决项说明它已经超时被摘掉了（或 id 重复）。静默丢弃是对的：
      // 迟到的响应不该让任何 Promise 复活。
      if (!entry) return;
      this.pending.delete(key);
      clearTimeout(entry.timer);
      if ('error' in msg && msg.error) {
        entry.reject(
          new Error(`${entry.method} 失败：${msg.error.message} (code ${msg.error.code})`),
        );
      } else {
        entry.resolve((msg as { result: unknown }).result);
      }
      return;
    }
    if (isJsonRpcRequest(msg)) {
      // 反向请求（采样 / roots）。当前只支持工具调用，明确回一个「不支持」，
      // 比让 server 一直等下去要好 —— 规范要求这种情况下必须回应。
      this.write({
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: MCP_ERROR.METHOD_NOT_FOUND,
          message: `客户端未实现服务端发起的 ${msg.method}`,
        },
      });
      return;
    }
    for (const handler of this.notificationHandlers) {
      handler(msg as JsonRpcNotification);
    }
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // stdin 已关闭：交由 exit 处理器统一收尾
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  /**
   * 发一条请求并等响应。超时/进程退出/取消/协议错误都会 reject，绝不挂起。
   *
   * `signal` 是**用户按停止**这一动作的传递路径：MCP 调用没有超时兜底之外的
   * 中断手段（一个跑十分钟的查询、一个卡住的数据库连接），不给信号的话
   * 「停止」要等到 requestTimeoutMs 才会生效。
   */
  request<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed || !this.child) {
      return Promise.reject(
        new McpTransportClosedError(`MCP 进程不可用，无法调用 ${method}（服务器未启动或已退出）`),
      );
    }
    const id = this.nextId++;
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`${method} 超时（${limit}ms）：MCP 服务器无响应`));
      }, limit);

      const onAbort = () => {
        // 只是放弃等待，不发 cancel 通知 —— MCP 协议里没有通用的取消方法，
        // 而服务器那边最终会随连接关闭一起收摊。这里的目标是让**界面**立刻恢复
        // 可用，而不是保证远端已经停止。
        this.pending.delete(id);
        cleanup();
        reject(new Error(`${method} 已被用户取消`));
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        timer,
        method,
      });
      this.write(message);
    });
  }

  /** 发一条不需要响应的通知。 */
  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /**
   * 关闭：先礼后兵。
   *
   * MCP 服务器大多会缓存状态（数据库连接、索引），直接 SIGKILL 会留下脏东西；
   * 但也不能无限等 —— 一个不响应 SIGTERM 的 server 会拖住应用退出。
   */
  async close(graceMs = 1500): Promise<void> {
    const child = this.child;
    this.closed = true;
    if (!child) return;
    this.failAll(new McpTransportClosedError('MCP 连接已关闭'));

    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
    try {
      child.kill('SIGTERM');
    } catch {}
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
    }, graceMs);
    await exited;
    clearTimeout(timer);
    this.child = null;
  }
}
