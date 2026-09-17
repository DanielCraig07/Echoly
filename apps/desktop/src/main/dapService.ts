import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import EventEmitter from 'node:events';
import type {
  DapBreakpoint,
  DapEvent,
  DapScope,
  DapStackFrame,
  DapThread,
  DapVariable,
} from '@deepseek-ide/shared';
import type { WorkspaceService } from './workspace';

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

export class DapService extends EventEmitter {
  private process: ChildProcess | null = null;
  private seq = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private isSessionActive = false;
  private breakpointsByPath = new Map<string, number[]>();

  constructor(private readonly resolveWorkspace: () => WorkspaceService) {
    super();
  }

  private get workspace(): WorkspaceService {
    return this.resolveWorkspace();
  }

  /**
   * Locate debugger executable (lldb-dap on macOS, or gdb on Linux).
   */
  private findDebuggerExecutable(): string | null {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    const candidates = isMac
      ? [
          '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap',
          '/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-vscode',
          '/opt/homebrew/bin/lldb-dap',
          '/usr/local/bin/lldb-dap',
          '/usr/bin/lldb-dap',
        ]
      : isWin
        ? ['lldb-dap.exe', 'gdb.exe']
        : ['/usr/bin/lldb-dap', '/usr/local/bin/lldb-dap', '/usr/bin/gdb'];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c;
      }
    }

    const envPath = process.env.PATH || '';
    const dirs = envPath.split(path.delimiter);
    for (const dir of dirs) {
      const p = path.join(dir, isWin ? 'lldb-dap.exe' : 'lldb-dap');
      if (fs.existsSync(p)) return p;
    }

    return null;
  }

  /**
   * Start a new debug session for a compiled binary.
   */
  async startSession(config: {
    program: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stopOnEntry?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    if (this.isSessionActive) {
      await this.stopSession();
    }

    const dbgBin = this.findDebuggerExecutable();
    if (!dbgBin) {
      return {
        success: false,
        error:
          '未找到 C/C++ 调试器 (lldb-dap)。在 macOS 上请安装 Xcode 命令行工具 (xcode-select --install) 或通过 Homebrew 安装 llvm。',
      };
    }

    let programPath = config.program;
    const root = this.workspace.getRoot();
    if (!path.isAbsolute(programPath) && root) {
      programPath = path.resolve(root, programPath);
    }

    if (!fs.existsSync(programPath)) {
      return {
        success: false,
        error: `调试目标二进制文件不存在: ${programPath}`,
      };
    }

    try {
      const child = spawn(dbgBin, [], {
        cwd: config.cwd || root || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.process = child;
      this.isSessionActive = true;
      this.seq = 1;
      this.buffer = Buffer.alloc(0);
      this.pendingRequests.clear();

      child.stdout?.on('data', (chunk: Buffer) => this.handleData(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        this.emit('event', {
          type: 'output',
          category: 'stderr',
          output: chunk.toString('utf8'),
        } as DapEvent);
      });

      child.on('exit', (code) => {
        this.isSessionActive = false;
        this.process = null;
        this.emit('event', {
          type: 'exited',
          exitCode: code ?? 0,
        } as DapEvent);
        this.emit('event', {
          type: 'terminated',
        } as DapEvent);
      });

      // 1. DAP initialize
      await this.sendRequest('initialize', {
        clientID: 'echoly',
        clientName: 'Echoly C/C++ Debugger',
        adapterID: 'lldb-dap',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
      });

      // 2. DAP launch
      await this.sendRequest('launch', {
        program: programPath,
        args: config.args || [],
        cwd: config.cwd || root || path.dirname(programPath),
        env: config.env || {},
        stopOnEntry: config.stopOnEntry ?? false,
      });

      // 3. Sync all pre-existing breakpoints
      for (const [bpPath, lines] of this.breakpointsByPath.entries()) {
        await this.sendBreakpointsToAdapter(bpPath, lines);
      }

      // 4. Configuration done
      await this.sendRequest('configurationDone', {});

      return { success: true };
    } catch (err: any) {
      this.isSessionActive = false;
      this.process = null;
      return {
        success: false,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Sends raw DAP request with timeout.
   */
  private sendRequest(command: string, args?: any): Promise<any> {
    if (!this.process || !this.process.stdin || !this.isSessionActive) {
      return Promise.reject(new Error('调试会话未建立或已终止'));
    }

    const seq = this.seq++;
    const payload = JSON.stringify({
      seq,
      type: 'request',
      command,
      arguments: args,
    });

    const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
    const message = header + payload;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(seq);
        reject(new Error(`DAP 请求超时 [command: ${command}, seq: ${seq}]`));
      }, 10000);

      this.pendingRequests.set(seq, { resolve, reject, timer });
      this.process!.stdin!.write(message, 'utf8');
    });
  }

  /**
   * Parses stream data according to Content-Length DAP framing.
   */
  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerIndex = this.buffer.indexOf('\r\n\r\n');
      if (headerIndex === -1) break;

      const headerString = this.buffer.slice(0, headerIndex).toString('utf8');
      const lengthMatch = headerString.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // Skip corrupt header
        this.buffer = this.buffer.slice(headerIndex + 4);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1], 10);
      const totalMessageLength = headerIndex + 4 + contentLength;

      if (this.buffer.length < totalMessageLength) {
        // Wait for remainder of chunk
        break;
      }

      const bodyBuffer = this.buffer.slice(headerIndex + 4, totalMessageLength);
      this.buffer = this.buffer.slice(totalMessageLength);

      try {
        const json = JSON.parse(bodyBuffer.toString('utf8'));
        this.processDapMessage(json);
      } catch (err) {
        console.warn('[DapService] JSON parse error on DAP stream:', err);
      }
    }
  }

  /**
   * Dispatches incoming DAP responses and events.
   */
  private processDapMessage(msg: any): void {
    if (msg.type === 'response') {
      const pending = this.pendingRequests.get(msg.request_seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.request_seq);
        if (msg.success) {
          pending.resolve(msg.body);
        } else {
          pending.reject(new Error(msg.message || 'DAP 命令失败'));
        }
      }
    } else if (msg.type === 'event') {
      const eventName = msg.event;
      const body = msg.body || {};

      if (eventName === 'stopped') {
        this.emit('event', {
          type: 'stopped',
          reason: body.reason,
          threadId: body.threadId,
          hitBreakpointIds: body.hitBreakpointIds,
        } as DapEvent);
      } else if (eventName === 'continued') {
        this.emit('event', {
          type: 'continued',
          threadId: body.threadId,
        } as DapEvent);
      } else if (eventName === 'output') {
        this.emit('event', {
          type: 'output',
          category: body.category || 'console',
          output: body.output,
        } as DapEvent);
      } else if (eventName === 'terminated') {
        this.emit('event', {
          type: 'terminated',
        } as DapEvent);
      }
    }
  }

  /**
   * Set and synchronize breakpoints for a source file.
   */
  async setBreakpoints(filePath: string, lines: number[]): Promise<DapBreakpoint[]> {
    this.breakpointsByPath.set(filePath, lines);

    if (this.isSessionActive) {
      return await this.sendBreakpointsToAdapter(filePath, lines);
    }

    return lines.map((line) => ({
      path: filePath,
      line,
      verified: true,
    }));
  }

  private async sendBreakpointsToAdapter(filePath: string, lines: number[]): Promise<DapBreakpoint[]> {
    try {
      const res = await this.sendRequest('setBreakpoints', {
        source: { path: filePath },
        breakpoints: lines.map((l) => ({ line: l })),
      });

      const bps: any[] = res?.breakpoints || [];
      return bps.map((b, idx) => ({
        id: b.id,
        path: filePath,
        line: b.line || lines[idx],
        verified: b.verified !== false,
      }));
    } catch {
      return lines.map((l) => ({ path: filePath, line: l, verified: false }));
    }
  }

  async continue(): Promise<void> {
    if (!this.isSessionActive) return;
    await this.sendRequest('continue', { threadId: 1 });
  }

  async stepOver(): Promise<void> {
    if (!this.isSessionActive) return;
    await this.sendRequest('next', { threadId: 1 });
  }

  async stepInto(): Promise<void> {
    if (!this.isSessionActive) return;
    await this.sendRequest('stepIn', { threadId: 1 });
  }

  async stepOut(): Promise<void> {
    if (!this.isSessionActive) return;
    await this.sendRequest('stepOut', { threadId: 1 });
  }

  async pause(): Promise<void> {
    if (!this.isSessionActive) return;
    await this.sendRequest('pause', { threadId: 1 });
  }

  async getThreads(): Promise<DapThread[]> {
    if (!this.isSessionActive) return [];
    try {
      const res = await this.sendRequest('threads');
      return (res?.threads || []).map((t: any) => ({
        id: t.id,
        name: t.name || `Thread #${t.id}`,
      }));
    } catch {
      return [];
    }
  }

  async getStackTrace(threadId = 1): Promise<DapStackFrame[]> {
    if (!this.isSessionActive) return [];
    try {
      const res = await this.sendRequest('stackTrace', {
        threadId,
        startFrame: 0,
        levels: 30,
      });

      const frames: any[] = res?.stackFrames || [];
      return frames.map((f) => ({
        id: f.id,
        name: f.name || 'anonymous',
        source: f.source ? { path: f.source.path, name: f.source.name } : undefined,
        line: f.line,
        column: f.column,
      }));
    } catch {
      return [];
    }
  }

  async getScopes(frameId: number): Promise<DapScope[]> {
    if (!this.isSessionActive) return [];
    try {
      const res = await this.sendRequest('scopes', { frameId });
      const scopes: any[] = res?.scopes || [];
      return scopes.map((s) => ({
        name: s.name,
        variablesReference: s.variablesReference,
        expensive: s.expensive,
      }));
    } catch {
      return [];
    }
  }

  async getVariables(variablesReference: number): Promise<DapVariable[]> {
    if (!this.isSessionActive || variablesReference <= 0) return [];
    try {
      const res = await this.sendRequest('variables', {
        variablesReference,
      });
      const vars: any[] = res?.variables || [];
      return vars.map((v) => ({
        name: v.name,
        value: v.value,
        type: v.type,
        variablesReference: v.variablesReference || 0,
      }));
    } catch {
      return [];
    }
  }

  async evaluate(expression: string, frameId?: number): Promise<{ result: string; type?: string }> {
    if (!this.isSessionActive) return { result: '调试会话未运行' };
    try {
      const res = await this.sendRequest('evaluate', {
        expression,
        frameId,
        context: 'repl',
      });
      return {
        result: res?.result || '',
        type: res?.type,
      };
    } catch (err: any) {
      return {
        result: `错误: ${err?.message || String(err)}`,
      };
    }
  }

  async stopSession(): Promise<void> {
    if (!this.isSessionActive && !this.process) return;

    try {
      if (this.process?.stdin) {
        await Promise.race([
          this.sendRequest('disconnect', { terminateDebuggee: true }),
          new Promise((r) => setTimeout(r, 800)),
        ]);
      }
    } catch {
      /* ignore */
    }

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
        const p = this.process;
        setTimeout(() => {
          if (!p.killed) p.kill('SIGKILL');
        }, 1000);
      } catch {
        /* ignore */
      }
      this.process = null;
    }

    this.isSessionActive = false;
    this.pendingRequests.clear();
  }

  dispose(): void {
    void this.stopSession();
    this.breakpointsByPath.clear();
    this.removeAllListeners();
  }
}
