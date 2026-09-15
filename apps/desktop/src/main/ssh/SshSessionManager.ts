import { Client, type SFTPWrapper, type ClientChannel } from 'ssh2';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import type { SshConnectRequest, SshConnectResult, SshProfile } from '@deepseek-ide/shared';
import type { CommandResult, DirEntry, WorkspaceBackend } from '@deepseek-ide/tools';
import type { WorkspaceService } from '../workspace';
import type { WindowSession } from '../windowRegistry';
import type { BrowserWindow } from 'electron';

interface LocalNcProxy {
  port: number;
  close: () => void;
}

/**
 * 在 macOS 上利用系统原生签名且无限制的 /usr/bin/nc 建立本地 TCP 代理。
 * 彻底解决 macOS 15 Sequoia 对打包后的桌面应用静默拦截局域网 socket (EHOSTUNREACH / Connection lost before handshake) 的问题。
 * 通过在 127.0.0.1 启动临时监听，让 ssh2 通过原生 net.Socket 连接本地回环（不受本地网络隐私策略拦截），
 * 并由系统原生工具 /usr/bin/nc 负责与远程局域网建立真实数据转发。
 */
function startLocalNcProxy(remoteHost: string, remotePort: number): Promise<LocalNcProxy> {
  return new Promise((resolve, reject) => {
    let closed = false;
    const activeSockets = new Set<net.Socket>();
    const activeProcesses = new Set<ReturnType<typeof spawn>>();

    const server = net.createServer((clientSock) => {
      activeSockets.add(clientSock);

      const nc = spawn('/usr/bin/nc', [remoteHost, String(remotePort)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      activeProcesses.add(nc);

      clientSock.pipe(nc.stdin);
      nc.stdout.pipe(clientSock);

      const cleanupConn = () => {
        activeSockets.delete(clientSock);
        activeProcesses.delete(nc);
        try {
          if (!nc.killed) nc.kill();
        } catch {
          // ignore
        }
        try {
          if (!clientSock.destroyed) clientSock.destroy();
        } catch {
          // ignore
        }
      };

      nc.on('error', cleanupConn);
      nc.on('close', cleanupConn);
      clientSock.on('error', cleanupConn);
      clientSock.on('close', cleanupConn);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('无法获取本地代理端口'));
      }
      resolve({
        port: addr.port,
        close: () => {
          if (closed) return;
          closed = true;
          try {
            server.close();
          } catch {
            // ignore
          }
          for (const s of activeSockets) {
            try {
              s.destroy();
            } catch {
              // ignore
            }
          }
          activeSockets.clear();
          for (const p of activeProcesses) {
            try {
              if (!p.killed) p.kill();
            } catch {
              // ignore
            }
          }
          activeProcesses.clear();
        },
      });
    });

    server.on('error', (err) => {
      reject(err);
    });
  });
}

function posixJoin(root: string, relPath = '.'): string {
  const cleaned = (relPath || '.').replace(/\\/g, '/');
  if (cleaned === '.' || cleaned === '') return root.replace(/\/$/, '') || '/';
  if (cleaned.startsWith('/')) {
    // absolute path — normalize and return
    const parts = cleaned.split('/').filter((p) => p && p !== '.');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') {
        out.pop();
      } else {
        out.push(p);
      }
    }
    return `/${out.join('/')}`;
  }
  const parts = [
    ...root.split('/').filter(Boolean),
    ...cleaned.split('/').filter((p) => p && p !== '.'),
  ];
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') {
      out.pop();
    } else {
      out.push(p);
    }
  }
  return `/${out.join('/')}`;
}

function toRel(root: string, abs: string): string {
  const rootN = root.replace(/\/$/, '') || '/';
  const absN = abs.replace(/\/$/, '') || '/';
  if (absN === rootN) return '.';
  if (absN.startsWith(`${rootN}/`)) return absN.slice(rootN.length + 1);
  return absN;
}

export class SftpBackend implements WorkspaceBackend {
  readonly kind = 'ssh' as const;

  constructor(
    public root: string,
    private readonly client: Client,
    private readonly sftp: SFTPWrapper,
  ) {}

  resolve(relPath = '.'): string {
    return posixJoin(this.root, relPath);
  }

  toRel(absOrRemotePath: string): string {
    return toRel(this.root, absOrRemotePath);
  }

  async listDir(relPath = '.'): Promise<DirEntry[]> {
    const abs = this.resolve(relPath);
    return await new Promise((resolve, reject) => {
      this.sftp.readdir(abs, (err, list) => {
        if (err) {
          const isNotFound = (err as any).code === 2 || err.message?.includes('No such file');
          if (isNotFound) return resolve([]);
          return reject(err);
        }
        resolve(
          list.map((e) => ({
            name: e.filename,
            isDirectory: (e.attrs.mode & 0o170000) === 0o040000,
          })),
        );
      });
    });
  }

  async readFile(relPath: string): Promise<string> {
    const abs = this.resolve(relPath);
    // 先检查文件大小
    const stat = await new Promise<{ size: number }>((resolve, reject) => {
      this.sftp.stat(abs, (err, stats) => {
        if (err) {
          const isNotFound = (err as any).code === 2 || err.message?.includes('No such file');
          reject(new Error(isNotFound ? `文件不存在: ${relPath}` : `无法获取文件信息: ${err.message}`));
        } else {
          resolve(stats);
        }
      });
    });
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    if (stat.size > MAX_SIZE) {
      throw new Error(
        `SSH 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB > 10MB): ${relPath}`,
      );
    }

    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      try {
        const stream = this.sftp.createReadStream(abs);
        stream.on('data', (d: Buffer) => {
          totalSize += d.length;
          if (totalSize > MAX_SIZE) {
            stream.destroy();
            reject(new Error(`读取中断：文件超过 10MB (${relPath})`));
            return;
          }
          chunks.push(d);
        });
        stream.on('error', (err: any) => {
          const errMsg = err?.message || err?.code || String(err) || '未知错误';
          reject(new Error(`读取远程文件失败 (${relPath}): ${errMsg}`));
        });
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`读取远程文件异常: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  async readFileLines(
    relPath: string,
    offset?: number,
    limit?: number,
  ): Promise<{ lines: string[]; total: number; offset: number; truncated: boolean }> {
    const text = await this.readFile(relPath);
    const allLines = text.split(/\r?\n/);
    const total = allLines.length;
    const start = Math.max((offset ?? 1) - 1, 0);
    const end = limit != null ? Math.min(start + limit, total) : total;
    return {
      lines: allLines.slice(start, end),
      total,
      offset: start + 1,
      truncated: end < total,
    };
  }

  async readFileBuffer(relPath: string): Promise<Buffer> {
    const abs = this.resolve(relPath);
    // 检查文件大小
    const stat = await new Promise<{ size: number }>((resolve, reject) => {
      this.sftp.stat(abs, (err, stats) => {
        if (err) reject(new Error(`无法获取文件信息: ${err.message}`));
        else resolve(stats);
      });
    });
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB
    if (stat.size > MAX_SIZE) {
      throw new Error(
        `SSH 文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB): ${relPath}`,
      );
    }

    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      try {
        const stream = this.sftp.createReadStream(abs);
        stream.on('data', (d: Buffer) => {
          totalSize += d.length;
          if (totalSize > MAX_SIZE) {
            stream.destroy();
            reject(new Error(`读取中断：文件超过 50MB (${relPath})`));
            return;
          }
          chunks.push(d);
        });
        stream.on('error', (err: any) => {
          const errMsg = err?.message || err?.code || String(err) || '未知错误';
          reject(new Error(`读取远程文件失败 (${relPath}): ${errMsg}`));
        });
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      } catch (err) {
        reject(new Error(`读取远程文件异常: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolve(relPath);
    const dir = abs.includes('/') ? abs.slice(0, abs.lastIndexOf('/')) || '/' : '/';
    await this.mkdirp(dir);

    // 1. 获取原文件权限位（若存在）
    let origMode: number | undefined;
    try {
      const stats = await new Promise<any>((resolve, reject) => {
        this.sftp.stat(abs, (err, st) => (err ? reject(err) : resolve(st)));
      });
      if (stats && typeof stats.mode === 'number') {
        origMode = stats.mode & 0o7777;
      }
    } catch {
      // 原文件不存在，保持 undefined
    }

    const targetMode = origMode !== undefined ? origMode : 0o644;

    await new Promise<void>((resolve, reject) => {
      // 显式指定 mode，避免 ssh2 默认使用 0o666 并执行 fchmod(handle, 0o666)
      const stream = this.sftp.createWriteStream(abs, { mode: targetMode });
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(content, 'utf8');
    });

    // 某些 SFTP 服务端写入后可能受 umask 影响，显式 chmod 确保保留原有权限位
    if (origMode !== undefined) {
      try {
        await new Promise<void>((resolve) => {
          this.sftp.chmod(abs, origMode, () => resolve());
        });
      } catch {
        // 忽略可能由于所有权导致的 chmod 报错
      }
    }
  }

  resolveAbsolute(relPath = '.'): string {
    return this.resolve(relPath);
  }

  async mkdir(relPath: string): Promise<void> {
    await this.mkdirp(this.resolve(relPath));
  }

  async exists(relPath: string): Promise<boolean> {
    const abs = this.resolve(relPath);
    return await new Promise((resolve) => {
      this.sftp.stat(abs, (err) => resolve(!err));
    });
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    const dir = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) || '/' : '/';
    await this.mkdirp(dir);
    await new Promise<void>((resolve, reject) => {
      this.sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
  }

  async remove(relPath: string): Promise<void> {
    const abs = this.resolve(relPath);
    const isDir = await new Promise<boolean>((resolve, reject) => {
      this.sftp.stat(abs, (err, stats) => {
        if (err) return reject(err);
        resolve((stats.mode & 0o170000) === 0o040000);
      });
    });
    if (isDir) {
      await this.removeDirRecursive(abs);
    } else {
      await new Promise<void>((resolve, reject) => {
        this.sftp.unlink(abs, (err) => (err ? reject(err) : resolve()));
      });
    }
  }

  private async removeDirRecursive(abs: string): Promise<void> {
    const list = await new Promise<Array<{ filename: string; isDirectory: boolean }>>(
      (resolve, reject) => {
        this.sftp.readdir(abs, (err, entries) => {
          if (err) return reject(err);
          resolve(
            entries.map((e) => ({
              filename: e.filename,
              isDirectory: (e.attrs.mode & 0o170000) === 0o040000,
            })),
          );
        });
      },
    );
    for (const entry of list) {
      const child = `${abs.replace(/\/$/, '')}/${entry.filename}`;
      if (entry.isDirectory) {
        await this.removeDirRecursive(child);
      } else {
        await new Promise<void>((resolve, reject) => {
          this.sftp.unlink(child, (err) => (err ? reject(err) : resolve()));
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.sftp.rmdir(abs, (err) => (err ? reject(err) : resolve()));
    });
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    const from = this.resolve(fromRel);
    const to = this.resolve(toRel);
    const isDir = await new Promise<boolean>((resolve, reject) => {
      this.sftp.stat(from, (err, stats) => {
        if (err) return reject(err);
        resolve((stats.mode & 0o170000) === 0o040000);
      });
    });
    if (isDir) {
      await this.copyDirRecursive(from, to);
    } else {
      await this.copyFile(from, to);
    }
  }

  private async copyFile(fromAbs: string, toAbs: string): Promise<void> {
    const dir = toAbs.includes('/') ? toAbs.slice(0, toAbs.lastIndexOf('/')) || '/' : '/';
    await this.mkdirp(dir);

    let origMode: number | undefined;
    try {
      const stats = await new Promise<any>((resolve, reject) => {
        this.sftp.stat(fromAbs, (err, st) => (err ? reject(err) : resolve(st)));
      });
      if (stats && typeof stats.mode === 'number') {
        origMode = stats.mode & 0o7777;
      }
    } catch {}

    const targetMode = origMode !== undefined ? origMode : 0o644;

    await new Promise<void>((resolve, reject) => {
      const read = this.sftp.createReadStream(fromAbs);
      const write = this.sftp.createWriteStream(toAbs, { mode: targetMode });
      read.on('error', reject);
      write.on('error', reject);
      write.on('close', () => resolve());
      read.pipe(write);
    });

    if (origMode !== undefined) {
      try {
        await new Promise<void>((resolve) => {
          this.sftp.chmod(toAbs, origMode, () => resolve());
        });
      } catch {}
    }
  }

  private async copyDirRecursive(fromAbs: string, toAbs: string): Promise<void> {
    let dirMode = 0o755;
    try {
      const st = await new Promise<any>((resolve, reject) => {
        this.sftp.stat(fromAbs, (err, s) => (err ? reject(err) : resolve(s)));
      });
      if (st && typeof st.mode === 'number') {
        dirMode = st.mode & 0o7777;
      }
    } catch {}

    await this.mkdirp(toAbs);
    try {
      await new Promise<void>((resolve) => {
        this.sftp.chmod(toAbs, dirMode, () => resolve());
      });
    } catch {}

    const list = await new Promise<Array<{ filename: string; isDirectory: boolean }>>(
      (resolve, reject) => {
        this.sftp.readdir(fromAbs, (err, entries) => {
          if (err) return reject(err);
          resolve(
            entries.map((e) => ({
              filename: e.filename,
              isDirectory: (e.attrs.mode & 0o170000) === 0o040000,
            })),
          );
        });
      },
    );
    for (const entry of list) {
      const childFrom = `${fromAbs.replace(/\/$/, '')}/${entry.filename}`;
      const childTo = `${toAbs.replace(/\/$/, '')}/${entry.filename}`;
      if (entry.isDirectory) {
        await this.copyDirRecursive(childFrom, childTo);
      } else {
        await this.copyFile(childFrom, childTo);
      }
    }
  }

  private async mkdirp(dir: string): Promise<void> {
    if (!dir || dir === '/') return;
    const parts = dir.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += `/${p}`;
      await new Promise<void>((resolve) => {
        this.sftp.mkdir(cur, { mode: 0o755 }, (err) => {
          // ignore exists
          void err;
          resolve();
        });
      });
    }
  }

  async runCommand(
    command: string,
    timeoutMs = 60_000,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<CommandResult> {
    return await new Promise((resolve) => {
      const wrapped = `cd ${shellQuote(this.root)} && ${command}`;
      this.client.exec(wrapped, (err, stream) => {
        if (err) {
          resolve({ stdout: '', stderr: err.message, code: 1 });
          return;
        }
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.close();
          resolve({ stdout, stderr: stderr || `timed out after ${timeoutMs}ms`, code: 124 });
        }, timeoutMs);
        stream.on('data', (d: Buffer) => {
          const chunk = d.toString('utf8');
          stdout += chunk;
          onChunk?.(chunk, 'stdout');
        });
        stream.stderr.on('data', (d: Buffer) => {
          const chunk = d.toString('utf8');
          stderr += chunk;
          onChunk?.(chunk, 'stderr');
        });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    });
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface LiveSsh {
  client: Client;
  sftp: SFTPWrapper;
  workspace: WorkspaceService;
  webContentsId: number;
  host?: string;
  port?: number;
  username?: string;
  browseOnly?: boolean;
}

/**
 * One SSH/SFTP connection per BrowserWindow. Connecting in window B must never
 * clear or steal window A's workspace.
 */
export class SshSessionManager {
  private readonly profilesPath: string;
  private readonly live = new Map<number, LiveSsh>();

  constructor(
    private readonly resolveSession: () => WindowSession,
    private readonly userDataPath: string,
    _getWindow: () => BrowserWindow | null,
  ) {
    this.profilesPath = path.join(userDataPath, 'ssh-profiles.json');
  }

  private liveForCurrent(): LiveSsh | null {
    const session = this.resolveSession();
    if (session.webContentsId >= 0) {
      const byId = this.live.get(session.webContentsId);
      if (byId) return byId;
    }
    for (const entry of this.live.values()) {
      if (entry.workspace === session.workspace) return entry;
    }
    return null;
  }

  async listProfiles(): Promise<SshProfile[]> {
    try {
      const raw = await fs.readFile(this.profilesPath, 'utf8');
      return JSON.parse(raw) as SshProfile[];
    } catch {
      return [];
    }
  }

  async listLocalConfig(): Promise<SshProfile[]> {
    const os = require('node:os');
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    try {
      const content = await fs.readFile(sshConfigPath, 'utf8');
      const lines = content.split('\n');
      const profiles: SshProfile[] = [];
      let current: Partial<SshProfile> | null = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const match = trimmed.match(/^(\w+)\s+(.+)$/i);
        if (!match) continue;

        const key = match[1].toLowerCase();
        const value = match[2];

        if (key === 'host') {
          if (current && current.host) {
            current.id = randomUUID();
            current.name = current.name || current.host;
            current.port = current.port || 22;
            current.username = current.username || os.userInfo().username;
            profiles.push(current as SshProfile);
          }
          current = { name: value, host: value };
        } else if (current) {
          if (key === 'hostname') current.host = value;
          else if (key === 'user') current.username = value;
          else if (key === 'port') current.port = parseInt(value, 10);
          else if (key === 'identityfile') {
            let p = value;
            if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
            current.privateKeyPath = p;
          }
        }
      }
      if (current && current.host && current.name !== '*') {
        current.id = randomUUID();
        current.name = current.name || current.host;
        current.port = current.port || 22;
        current.username = current.username || os.userInfo().username;
        profiles.push(current as SshProfile);
      }

      return profiles.filter((p) => !p.name.includes('*'));
    } catch {
      return [];
    }
  }

  async saveProfiles(profiles: SshProfile[]): Promise<void> {
    await fs.mkdir(path.dirname(this.profilesPath), { recursive: true });
    await fs.writeFile(this.profilesPath, JSON.stringify(profiles, null, 2), 'utf8');
  }

  async saveProfile(
    profile: Partial<SshProfile> & { host: string; username: string },
  ): Promise<void> {
    const profiles = await this.listProfiles();
    const port = Number(profile.port) || 22;
    const newP: SshProfile = {
      id: profile.id || randomUUID(),
      name: profile.name || `${profile.username}@${profile.host}`,
      host: profile.host,
      port,
      username: profile.username,
      privateKeyPath: profile.privateKeyPath,
      remotePath: profile.remotePath || '',
    };
    const withoutDup = profiles.filter(
      (p) => !(p.host === newP.host && p.username === newP.username && p.port === newP.port),
    );
    withoutDup.push(newP);
    await this.saveProfiles(withoutDup);
  }

  async deleteProfile(id: string): Promise<void> {
    const profiles = await this.listProfiles();
    await this.saveProfiles(profiles.filter((p) => p.id !== id));
  }

  isConnected(): boolean {
    return !!this.liveForCurrent();
  }

  /** Disconnect only the given window's SSH (or current window if omitted). */
  async disconnect(webContentsId?: number): Promise<void> {
    const id =
      webContentsId ??
      (() => {
        try {
          return this.resolveSession().webContentsId;
        } catch {
          return -1;
        }
      })();
    if (id < 0) return;
    this.disconnectWindow(id);
  }

  disconnectWindow(webContentsId: number): void {
    const live = this.live.get(webContentsId);
    if (!live) return;
    this.live.delete(webContentsId);
    if (!live.browseOnly && live.workspace.getKind() === 'ssh') {
      live.workspace.clearRemote();
    }
    try {
      live.client.end();
    } catch {
      // ignore
    }
  }

  getActiveSession(): {
    host: string;
    port: number;
    username: string;
    remoteRoot: string;
  } | null {
    try {
      const windowSession = this.resolveSession();
      const webContentsId = windowSession.webContentsId;
      const live = webContentsId >= 0 ? this.live.get(webContentsId) : null;
      if (!live || !live.host || !live.username) return null;
      return {
        host: live.host,
        port: live.port ?? 22,
        username: live.username,
        remoteRoot: windowSession.workspace.getRoot() || '',
      };
    } catch {
      return null;
    }
  }

  async switchRemotePath(remotePath: string): Promise<SshConnectResult> {
    const windowSession = this.resolveSession();
    const workspace = windowSession.workspace;
    const webContentsId = windowSession.webContentsId;
    const existingLive = webContentsId >= 0 ? this.live.get(webContentsId) : null;
    if (!existingLive) {
      return { ok: false, detail: '当前窗口无活动的 SSH 连接' };
    }

    const user = existingLive.username || 'user';
    let remoteRoot = remotePath?.trim() || '';
    if (!remoteRoot) {
      remoteRoot = await new Promise<string>((resolve) => {
        existingLive.client.exec('pwd', (err, stream) => {
          if (err) return resolve(`/home/${user}`);
          let out = '';
          stream.on('data', (d: Buffer) => {
            out += d.toString('utf8');
          });
          stream.on('close', () => resolve(out.trim() || `/home/${user}`));
        });
      });
    }
    remoteRoot = remoteRoot.replace(/\\/g, '/').replace(/\/$/, '') || '/';

    const backend = new SftpBackend(remoteRoot, existingLive.client, existingLive.sftp);
    const host = existingLive.host || 'remote';
    const label = `ssh ${user}@${host}:${remoteRoot}`;
    workspace.setRemoteBackend(backend, label);
    existingLive.browseOnly = false;
    return { ok: true, detail: `已切换至 ${label}`, root: remoteRoot, label };
  }

  async connect(req: SshConnectRequest): Promise<SshConnectResult> {
    // Capture owning window BEFORE any await (ALS must not be relied on after yields).
    const windowSession = this.resolveSession();
    const workspace = windowSession.workspace;
    const webContentsId = windowSession.webContentsId;

    const port = req.port ?? 22;
    const browseOnly = req.browseOnly === true;

    // 检查当前窗口是否已有连向相同服务器的活动连接（若未传 host 则直接复用当前连接）
    const existingLive = webContentsId >= 0 ? this.live.get(webContentsId) : null;
    const isSameServer =
      existingLive &&
      (!req.host || existingLive.host === req.host) &&
      (!req.username || existingLive.username === req.username);

    if (isSameServer && existingLive) {
      if (browseOnly) {
        return { ok: true, detail: `已连接 ${existingLive.username}@${existingLive.host}` };
      }

      // 复用已有连接，正式打开指定的工作区目录
      let remoteRoot = req.remotePath?.trim() || '';
      if (!remoteRoot) {
        remoteRoot = await new Promise<string>((resolve) => {
          existingLive.client.exec('pwd', (err, stream) => {
            if (err) return resolve(`/home/${req.username}`);
            let out = '';
            stream.on('data', (d: Buffer) => {
              out += d.toString('utf8');
            });
            stream.on('close', () => resolve(out.trim() || `/home/${req.username}`));
          });
        });
      }
      remoteRoot = remoteRoot.replace(/\\/g, '/').replace(/\/$/, '') || '/';

      const backend = new SftpBackend(remoteRoot, existingLive.client, existingLive.sftp);
      const label = `ssh ${req.username}@${req.host}:${remoteRoot}`;
      workspace.setRemoteBackend(backend, label);
      existingLive.browseOnly = false;

      if (req.saveProfile) {
        const profiles = await this.listProfiles();
        const profile: SshProfile = {
          id: randomUUID(),
          name: req.profileName || `${req.username}@${req.host}`,
          host: req.host,
          port,
          username: req.username,
          privateKeyPath: req.privateKeyPath,
          remotePath: remoteRoot,
        };
        const withoutDup = profiles.filter(
          (p) =>
            !(
              p.host === profile.host &&
              p.username === profile.username &&
              p.port === profile.port
            ),
        );
        withoutDup.push(profile);
        await this.saveProfiles(withoutDup);
      }

      return { ok: true, root: remoteRoot, label, detail: `已连接 ${label}` };
    }

    this.disconnectWindow(webContentsId);

    let privateKey: Buffer | undefined;
    if (req.privateKeyPath) {
      try {
        privateKey = await fs.readFile(req.privateKeyPath);
      } catch (err) {
        return {
          ok: false,
          detail: `无法读取私钥: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else if (!req.password) {
      const os = require('node:os');
      const home = os.homedir();
      const candidates = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];
      for (const name of candidates) {
        const keyPath = path.join(home, '.ssh', name);
        try {
          privateKey = await fs.readFile(keyPath);
          if (privateKey) break;
        } catch {
          // ignore
        }
      }
    }

    let client = new Client();
    let bridgeCleanup: (() => void) | null = null;

    const baseConnectConfig = {
      host: req.host,
      port,
      username: req.username,
      password: req.password,
      privateKey,
      passphrase: req.passphrase,
      agent: process.env.SSH_AUTH_SOCK,
      readyTimeout: 20000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3,
    };

    try {
      try {
        await new Promise<void>((resolve, reject) => {
          client
            .on('ready', () => resolve())
            .on('error', reject)
            .connect(baseConnectConfig);
        });
      } catch (firstErr) {
        const rawMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
        const isAuthError =
          rawMsg.includes('All configured authentication methods failed') ||
          rawMsg.includes('authentication') ||
          rawMsg.includes('key is invalid') ||
          rawMsg.includes('passphrase');

        // 在 macOS 平台，当连接局域网遇到网络不可达、连接重置或握手前断开时（通常受 macOS 15 Local Network 隐私机制或 TCC 缓存阻断），
        // 自动利用系统内置且拥有完整原生网络权限的 /usr/bin/nc 建立本地回环 TCP 代理进行无缝重连自愈
        if (
          !isAuthError &&
          process.platform === 'darwin' &&
          fsSync.existsSync('/usr/bin/nc')
        ) {
          try {
            client.end();
          } catch {
            // ignore
          }
          const proxy = await startLocalNcProxy(req.host, port);
          bridgeCleanup = proxy.close;

          const retryClient = new Client();
          await new Promise<void>((resolve, reject) => {
            retryClient
              .on('ready', () => resolve())
              .on('error', (retryErr) => {
                proxy.close();
                reject(retryErr);
              })
              .connect({
                ...baseConnectConfig,
                host: '127.0.0.1',
                port: proxy.port,
                readyTimeout: 20000,
              });
          });
          client = retryClient;
        } else {
          throw firstErr;
        }
      }

      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, s) => (err ? reject(err) : resolve(s)));
      });

      let remoteRoot = req.remotePath?.trim() || '';
      if (!remoteRoot) {
        remoteRoot = await new Promise<string>((resolve) => {
          client.exec('pwd', (err, stream) => {
            if (err) return resolve(`/home/${req.username}`);
            let out = '';
            stream.on('data', (d: Buffer) => {
              out += d.toString('utf8');
            });
            stream.on('close', () => resolve(out.trim() || `/home/${req.username}`));
          });
        });
      }
      remoteRoot = remoteRoot.replace(/\\/g, '/').replace(/\/$/, '') || '/';

      const label = `ssh ${req.username}@${req.host}:${remoteRoot}`;

      if (webContentsId >= 0) {
        this.live.set(webContentsId, {
          client,
          sftp,
          workspace,
          webContentsId,
          host: req.host,
          port,
          username: req.username,
          browseOnly,
        });
      }

      // 注册常驻连接生命周期监听，网络中断时及时释放，避免连接僵死
      const cleanupDeadConnection = () => {
        if (bridgeCleanup) {
          bridgeCleanup();
          bridgeCleanup = null;
        }
        if (webContentsId >= 0) {
          const cur = this.live.get(webContentsId);
          if (cur && cur.client === client) {
            this.live.delete(webContentsId);
          }
        }
      };
      client.on('close', cleanupDeadConnection);
      client.on('end', cleanupDeadConnection);
      client.on('error', () => {
        cleanupDeadConnection();
      });

      // 仅当非 browseOnly 模式时才真正切换工作区并保存配置
      if (!browseOnly) {
        const backend = new SftpBackend(remoteRoot, client, sftp);
        workspace.setRemoteBackend(backend, label);

        if (req.saveProfile) {
          const profiles = await this.listProfiles();
          const profile: SshProfile = {
            id: randomUUID(),
            name: req.profileName || `${req.username}@${req.host}`,
            host: req.host,
            port,
            username: req.username,
            privateKeyPath: req.privateKeyPath,
            remotePath: remoteRoot,
          };
          const withoutDup = profiles.filter(
            (p) =>
              !(
                p.host === profile.host &&
                p.username === profile.username &&
                p.port === profile.port
              ),
          );
          withoutDup.push(profile);
          await this.saveProfiles(withoutDup);
        }
      }

      return {
        ok: true,
        root: browseOnly ? undefined : remoteRoot,
        label: browseOnly ? undefined : label,
        detail: `已连接 ${label}`,
      };
    } catch (err) {
      if (bridgeCleanup) {
        bridgeCleanup();
        bridgeCleanup = null;
      }
      try {
        client.end();
      } catch {
        // ignore
      }
      if (webContentsId >= 0) this.live.delete(webContentsId);

      const rawMsg = err instanceof Error ? err.message : String(err);
      let detail = rawMsg;

      const host = req.host || '';
      const isLocalHost =
        host === 'localhost' ||
        host === '127.0.0.1' ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host.endsWith('.local');

      const isNetworkUnreachable =
        rawMsg.includes('EHOSTUNREACH') ||
        rawMsg.includes('ENETUNREACH') ||
        rawMsg.includes('No route to host') ||
        rawMsg.includes('ETIMEDOUT') ||
        rawMsg.includes('EACCES') ||
        rawMsg.includes('EPERM') ||
        rawMsg.includes('Connection lost before handshake') ||
        rawMsg.includes('ECONNRESET');

      if (rawMsg.includes('All configured authentication methods failed')) {
        detail = `认证失败：请检查用户名、密码或私钥口令是否正确 (${rawMsg})`;
      } else if (isLocalHost && isNetworkUnreachable) {
        if (process.platform === 'darwin') {
          detail = `无法连接本地网络服务器 (${host}:${port}): ${rawMsg}。由于 macOS 隐私保护机制，请前往「系统设置 -> 隐私与安全性 -> 本地网络」，确保已允许 Echoly (或 Electron) 访问本地网络；同时确认局域网 IP 与网络路由可达。`;
        } else {
          detail = `无法连接局域网服务器 (${host}:${port}): ${rawMsg}。请检查局域网连接、目标 IP 与防火墙设置。`;
        }
      }

      return {
        ok: false,
        detail,
      };
    }
  }

  async listRemoteDir(targetPath?: string): Promise<{
    ok: boolean;
    entries?: Array<{ name: string; isDirectory: boolean; path: string }>;
    currentPath?: string;
    detail?: string;
  }> {
    const live = this.liveForCurrent();
    if (!live) {
      return { ok: false, detail: 'SSH 未连接' };
    }

    try {
      let abs = targetPath?.trim() || '';
      if (!abs) {
        abs = await new Promise<string>((resolve) => {
          live.client.exec('pwd', (err, stream) => {
            if (err) return resolve('/home');
            let out = '';
            stream.on('data', (d: Buffer) => (out += d.toString('utf8')));
            stream.on('close', () => resolve(out.trim() || '/home'));
          });
        });
      }

      abs = abs.replace(/\\/g, '/').replace(/\/$/, '') || '/';

      const entries = await new Promise<
        Array<{ name: string; isDirectory: boolean; path: string }>
      >((resolve, reject) => {
        live.sftp.readdir(abs, (err, list) => {
          if (err) return reject(err);
          const dirs = list
            .filter(
              (e) =>
                (e.attrs.mode & 0o170000) === 0o040000 && e.filename !== '.' && e.filename !== '..',
            )
            .map((e) => ({
              name: e.filename,
              isDirectory: true,
              path: abs === '/' ? `/${e.filename}` : `${abs}/${e.filename}`,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          resolve(dirs);
        });
      });

      return { ok: true, entries, currentPath: abs };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async runCommand(
    command: string,
    timeoutMs = 60_000,
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<CommandResult> {
    const live = this.liveForCurrent();
    if (!live) {
      return { stdout: '', stderr: 'SSH 未连接', code: 1 };
    }
    const root = live.workspace.getRoot() || '.';
    return await new Promise((resolve) => {
      const wrapped = `cd ${shellQuote(root)} && ${command}`;
      live.client.exec(wrapped, (err, stream) => {
        if (err) {
          if (
            err.message.includes('not open') ||
            err.message.includes('closed') ||
            err.message.includes('ended')
          ) {
            const wId = live.webContentsId;
            if (wId >= 0) this.live.delete(wId);
          }
          resolve({ stdout: '', stderr: err.message, code: 1 });
          return;
        }
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          stream.close();
          resolve({ stdout, stderr: stderr || `timed out after ${timeoutMs}ms`, code: 124 });
        }, timeoutMs);
        stream.on('data', (d: Buffer) => {
          const chunk = d.toString('utf8');
          stdout += chunk;
          onChunk?.(chunk, 'stdout');
        });
        stream.stderr.on('data', (d: Buffer) => {
          const chunk = d.toString('utf8');
          stderr += chunk;
          onChunk?.(chunk, 'stderr');
        });
        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code: code ?? 0 });
        });
      });
    });
  }

  openShell(
    onData: (data: string) => void,
    onClose: (code: number) => void,
    initialCols?: number,
    initialRows?: number,
  ): {
    write: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    close: () => void;
  } | null {
    const live = this.liveForCurrent();
    if (!live) return null;
    let channel: ClientChannel | null = null;
    let pendingResize: { cols: number; rows: number } | null =
      initialCols && initialRows ? { cols: initialCols, rows: initialRows } : null;
    const pendingWrites: string[] = [];

    const shellOptions: { term: string; cols?: number; rows?: number } = {
      term: 'xterm-256color',
    };
    if (initialCols && initialCols >= 20 && initialRows && initialRows >= 3) {
      shellOptions.cols = initialCols;
      shellOptions.rows = initialRows;
    }

    live.client.shell(shellOptions, (err, stream) => {
      if (err) {
        onData(`\r\n[ssh shell error] ${err.message}\r\n`);
        onClose(1);
        return;
      }
      channel = stream;
      if (pendingResize) {
        stream.setWindow(pendingResize.rows, pendingResize.cols, 0, 0);
        pendingResize = null;
      }
      while (pendingWrites.length > 0) {
        const chunk = pendingWrites.shift();
        if (chunk) stream.write(chunk);
      }
      const root = live.workspace.getRoot();
      if (root) {
        stream.write(`cd ${shellQuote(root)}\n`);
      }
      stream.on('data', (d: Buffer) => onData(d.toString('utf8')));
      stream.stderr.on('data', (d: Buffer) => onData(d.toString('utf8')));
      stream.on('close', () => onClose(0));
    });
    return {
      write: (data) => {
        if (channel) {
          channel.write(data);
        } else {
          pendingWrites.push(data);
        }
      },
      resize: (cols, rows) => {
        if (channel) {
          channel.setWindow(rows, cols, 0, 0);
        } else {
          pendingResize = { cols, rows };
        }
      },
      close: () => channel?.close(),
    };
  }
}
