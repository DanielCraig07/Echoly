import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureParentDir, resolveInWorkspace, toPosixRel } from './pathJail.js';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
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
  runCommand(
    command: string,
    timeoutMs?: number,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
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

  resolveAbsolute(relPath = '.'): string {
    return this.resolve(relPath);
  }

  toRel(absPath: string): string {
    return toPosixRel(this.root, absPath);
  }

  async listDir(relPath = '.'): Promise<DirEntry[]> {
    const abs = this.resolve(relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }

  async readFile(relPath: string): Promise<string> {
    const abs = this.resolve(relPath);
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

  async readFileLines(
    relPath: string,
    offset?: number,
    limit?: number,
  ): Promise<{ lines: string[]; total: number; offset: number; truncated: boolean }> {
    const abs = this.resolve(relPath);
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
    const abs = this.resolve(relPath);
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
    const abs = this.resolve(relPath);
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
    await fs.mkdir(this.resolve(relPath), { recursive: true, mode: 0o755 });
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    await ensureParentDir(to);
    await fs.rename(from, to);
  }

  async remove(relPath: string): Promise<void> {
    await fs.rm(this.resolve(relPath), { recursive: true, force: true });
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
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

  async exists(relPath: string): Promise<boolean> {
    try {
      if (path.isAbsolute(relPath)) {
        await fs.access(relPath);
        return true;
      }
      await fs.access(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async runCommand(
    command: string,
    timeoutMs = 60_000,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<CommandResult> {
    const isWin = process.platform === 'win32';
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/bash';
    const args = isWin ? ['/d', '/s', '/c', command] : ['-lc', command];

    return await new Promise((resolve) => {
      const child = spawn(shell, args, {
        cwd: this.root,
        env: process.env,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ stdout, stderr: stderr || `timed out after ${timeoutMs}ms`, code: 124 });
      }, timeoutMs);

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
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 1 });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: err.message, code: 1 });
      });
    });
  }
}
