import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  assertRealPathInside,
  ensureParentDir,
  resolveInWorkspace,
  toPosixRel,
} from './pathJail.js';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * 文件的时间戳与大小，供增量索引用。
 *
 * 做成可选方法而不是必选：`WorkspaceBackend` 有好几个只实现了读写子集的实现
 * （测试里的内存后端、部分远端后端）。强制要求 `stat` 会让它们全部编译不过，
 * 而调用方真正需要的语义只是「拿不到就当作每次都变了」—— 那是**慢**，不是**错**。
 */
export interface FileStat {
  size: number;
  mtimeMs: number;
}

export interface WorkspaceBackend {
  kind: 'local' | 'ssh';
  root: string;
  listDir(relPath?: string): Promise<DirEntry[]>;
  readFile(relPath: string): Promise<string>;
  /** Read a 1-based line range. When offset/limit omitted, returns whole file (subject to size cap). */
  readFileLines(
    relPath: string,
    offset?: number,
    limit?: number,
  ): Promise<{ lines: string[]; total: number; offset: number; truncated: boolean }>;
  writeFile(relPath: string, content: string): Promise<void>;
  mkdir(relPath: string): Promise<void>;
  rename(fromRel: string, toRel: string): Promise<void>;
  remove(relPath: string): Promise<void>;
  copy(fromRel: string, toRel: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  /** Absolute local path or remote rooted path for display / download. */
  resolveAbsolute(relPath?: string): string;
  readFileBuffer?(relPath: string): Promise<Buffer>;
  /** 文件时间戳与大小；不支持的后端可以不实现，调用方须按「每次都变」处理。 */
  stat?(relPath: string): Promise<FileStat | null>;
  runCommand(
    command: string,
    timeoutMs?: number,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    /** 外部取消信号：用户按「停止」时子进程应当立刻结束，而不是等满超时。 */
    signal?: AbortSignal,
  ): Promise<CommandResult>;
  /** Absolute or rooted path for display / jail; relative paths are preferred for tools. */
  resolve(relPath?: string): string;
  toRel(absOrRemotePath: string): string;
}

async function copyDirLocal(src: string, dest: string): Promise<void> {
  const srcStat = await fs.stat(src);
  await fs.mkdir(dest, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') {
    try {
      await fs.chmod(dest, srcStat.mode & 0o7777);
    } catch {}
  }
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirLocal(from, to);
    } else {
      await fs.copyFile(from, to);
      if (process.platform !== 'win32') {
        try {
          const st = await fs.stat(from);
          await fs.chmod(to, st.mode & 0o7777);
        } catch {}
      }
    }
  }
}

export class LocalFsBackend implements WorkspaceBackend {
  readonly kind = 'local' as const;

  constructor(public root: string) {
    this.root = path.resolve(root);
  }

  resolve(relPath = '.'): string {
    return resolveInWorkspace(this.root, relPath);
  }

  /**
   * 词法校验 + 符号链接校验。
   *
   * 所有真正落到文件系统的操作都走这里：`resolveInWorkspace` 只挡 `..` 与绝对路径，
   * 挡不住工作区内一个指向 `/etc` 的软链（`link/hosts` 词法上完全合法）。
   * `assertRealPathInside` 会把已存在的祖先 realpath 后重新比对。
   */
  async resolveSafe(relPath = '.'): Promise<string> {
    const abs = this.resolve(relPath);
    await assertRealPathInside(this.root, abs);
    return abs;
  }

  resolveAbsolute(relPath = '.'): string {
    return this.resolve(relPath);
  }

  toRel(absPath: string): string {
    return toPosixRel(this.root, absPath);
  }

  async listDir(relPath = '.'): Promise<DirEntry[]> {
    const abs = await this.resolveSafe(relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  async readFile(relPath: string): Promise<string> {
    const abs = await this.resolveSafe(relPath);
    // 大文件保护：检查文件大小
    const stat = await fs.stat(abs);
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 10MB): ${relPath}`,
      );
    }
    return fs.readFile(abs, 'utf8');
  }

  /**
   * 时间戳 + 大小。取不到（文件不存在 / 权限不足）返回 null，
   * 而不是抛异常：调用方（增量索引）把 null 当作「变了，去读一次」，
   * 一次 stat 失败不该让整轮索引中断。
   */
  async stat(relPath: string): Promise<FileStat | null> {
    try {
      const s = await fs.stat(await this.resolveSafe(relPath));
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  }

  async readFileLines(
    relPath: string,
    offset?: number,
    limit?: number,
  ): Promise<{ lines: string[]; total: number; offset: number; truncated: boolean }> {
    const abs = await this.resolveSafe(relPath);
    const stat = await fs.stat(abs);
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB for line-range reads
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB): ${relPath}`,
      );
    }
    const text = await fs.readFile(abs, 'utf8');
    const allLines = text.split(/\r?\n/);
    const total = allLines.length;
    const start = Math.max((offset ?? 1) - 1, 0);
    const end = limit != null ? Math.min(start + limit, total) : total;
    const slice = allLines.slice(start, end);
    return {
      lines: slice,
      total,
      offset: start + 1,
      truncated: end < total,
    };
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    const abs = await this.resolveSafe(relPath);
    // 大文件保护
    const stat = await fs.stat(abs);
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB（Buffer 允许更大）
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB): ${relPath}`,
      );
    }
    return fs.readFile(abs);
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = await this.resolveSafe(relPath);
    await ensureParentDir(abs);
    let origMode: number | undefined;
    try {
      const st = await fs.stat(abs);
      origMode = st.mode;
    } catch {}
    await fs.writeFile(abs, content, {
      encoding: 'utf8',
      mode: origMode !== undefined ? origMode & 0o7777 : 0o644,
    });
    if (origMode !== undefined && process.platform !== 'win32') {
      try {
        await fs.chmod(abs, origMode & 0o7777);
      } catch {}
    }
  }

  async mkdir(relPath: string): Promise<void> {
    await fs.mkdir(await this.resolveSafe(relPath), { recursive: true, mode: 0o755 });
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = await this.resolveSafe(fromRel);
    const to = await this.resolveSafe(toRel);
    await ensureParentDir(to);
    await fs.rename(from, to);
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(await this.resolveSafe(relPath), { recursive: true, force: true });
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    const from = await this.resolveSafe(fromRel);
    const to = await this.resolveSafe(toRel);
    await ensureParentDir(to);
    const stat = await fs.stat(from);
    if (stat.isDirectory()) {
      await copyDirLocal(from, to);
    } else {
      await fs.copyFile(from, to);
      if (process.platform !== 'win32') {
        try {
          await fs.chmod(to, stat.mode & 0o7777);
        } catch {}
      }
    }
  }

  /**
   * 存在性探测同样要过 jail。
   *
   * 之前这里对绝对路径直接用 `fs.access` 放行，等于给渲染层留了一个
   * 「任意路径探针」：`exists('/etc/passwd')` 在 `resolveInWorkspace` 之外悄悄返回 true。
   * 路径不存在时 `resolveSafe` 也拿不到 realpath 基准，但那是**探测失败**而不是**探测成功**，
   * 返回 false 正好符合语义。
   */
  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(await this.resolveSafe(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async runCommand(
    command: string,
    timeoutMs = 60_000,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const isWin = process.platform === 'win32';
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/bash';
    const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', command];

    return await new Promise((resolve) => {
      const child = spawn(shell, args, {
        cwd: this.root,
        env: process.env,
        windowsHide: true,
        // 独立进程组：超时/取消时要杀掉的是**整棵进程树**，
        // 否则 `npm run build` 留下的子进程会继续占着端口与 CPU，
        // 而用户看到的是「停止没反应」。
        detached: !isWin,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const killTree = () => {
        try {
          if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // 已经退出了
          }
        }
      };

      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        killTree();
        finish({ stdout, stderr: stderr || `timed out after ${timeoutMs}ms`, code: 124 });
      }, timeoutMs);

      const onAbort = () => {
        killTree();
        finish({ stdout, stderr: stderr || 'cancelled', code: 130 });
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (d) => {
        const chunk = String(d);
        stdout += chunk;
        onChunk?.(chunk, 'stdout');
      });
      child.stderr.on('data', (d) => {
        const chunk = String(d);
        stderr += chunk;
        onChunk?.(chunk, 'stderr');
      });
      child.on('close', (code) => {
        finish({ stdout, stderr, code: code ?? 1 });
      });
      child.on('error', (err) => {
        finish({ stdout, stderr: err.message, code: 1 });
      });
    });
  }
}
