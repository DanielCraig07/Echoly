import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import electronLog from 'electron-log';
import type { FileTreeNode, WorkspaceInfo, WorkspaceKind } from '@deepseek-ide/shared';
import { LocalFsBackend, type WorkspaceBackend } from '@deepseek-ide/tools';
import { projectConfigChildPath, projectConfigDir } from './projectConfig';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

function mimeFromPath(relPath: string): string {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

export class WorkspaceService {
  private backend: WorkspaceBackend | null = null;
  private kind: WorkspaceKind = 'local';
  private label = '未打开工作区';
  private onChange: ((info: WorkspaceInfo) => void) | null = null;
  private onFsChange: ((data: { type: string; path?: string }) => void) | null = null;
  private watcher: fsSync.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;

  setChangeListener(cb: (info: WorkspaceInfo) => void): void {
    this.onChange = cb;
  }

  setFsChangeListener(cb: (data: { type: string; path?: string }) => void): void {
    this.onFsChange = cb;
  }

  notifyFsChange(type: string, relPath?: string): void {
    this.onFsChange?.({ type, path: relPath });
  }

  private stopWatcher(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {}
      this.watcher = null;
    }
  }

  private startWatcher(root: string): void {
    this.stopWatcher();
    if (!root || !fsSync.existsSync(root)) return;
    try {
      this.watcher = fsSync.watch(root, { recursive: true }, (_eventType, filename) => {
        if (filename) {
          const fn = String(filename);
          if (
            fn.includes('.git') ||
            fn.includes('node_modules') ||
            fn.includes('.DS_Store') ||
            fn.startsWith('.echoly/bin')
          ) {
            return;
          }
        }
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          this.notifyFsChange('watch', filename ? String(filename) : undefined);
        }, 120);
      });
      this.watcher.on('error', (err) => {
        electronLog.warn('[workspace] fs watcher error:', err);
      });
    } catch (e) {
      electronLog.warn('[workspace] Failed to start fs watcher for', root, e);
    }
  }

  dispose(): void {
    this.stopWatcher();
  }

  private emit(): void {
    this.onChange?.(this.getInfo());
  }

  getInfo(): WorkspaceInfo {
    return {
      kind: this.kind,
      root: this.backend?.root ?? null,
      label: this.label,
    };
  }

  getRoot(): string | null {
    return this.backend?.root ?? null;
  }

  getBackend(): WorkspaceBackend | null {
    return this.backend;
  }

  getKind(): WorkspaceKind {
    return this.kind;
  }

  // ── 项目级配置（数据库连接 / 查询脚本）的落盘位置 ─────────────────────────
  //
  // 配置**不写进工作区**，而是落到 `~/.echoly/projects/<工作区哈希>/`：项目里不留多余目录，
  // 换台机器 clone 下来也不会看到一份没用的、解不开的密码文件。但配置仍然与项目绑定 ——
  // 目录按工作区根派生，切项目就换目录。
  //
  // 目录本身**不预先创建**：打开一个文件夹就往用户主目录里落一个目录太粗暴，
  // 而且大多数项目根本没用过这些功能。写第一个文件时父目录自然就有了。
  //
  // 下面这几个方法只服务「用户直接操作的项目配置」通道（IPC projectConfig:*）；
  // 数据库连接走的是 windowRegistry 里的另一层映射，两者共用 projectConfig 的路径规则。

  /** 配置目录下的某个文件（工作区相对路径 → 本地绝对路径） */
  resolveProjectConfigPath(relPath: string): string | null {
    const root = this.getRoot();
    if (!root) return null;
    return projectConfigChildPath(root, relPath);
  }

  /** 读取配置目录里的文件；不存在或读不了都返回 null（配置永远是可选的） */
  async readProjectConfigFile(relPath: string): Promise<string | null> {
    const abs = this.resolveProjectConfigPath(relPath);
    if (!abs) return null;
    try {
      return await fs.readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** 写配置目录里的文件，父目录自动创建 */
  async writeProjectConfigFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolveProjectConfigPath(relPath);
    if (!abs) throw new Error('未打开工作区，无法保存项目配置');
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  /** 列配置目录下的子项（只回名字与是否目录，够渲染层拼查询脚本清单用） */
  async listProjectConfigDir(relPath = ''): Promise<Array<{ name: string; isDirectory: boolean }>> {
    const abs = this.resolveProjectConfigPath(relPath);
    if (!abs) return [];
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
    } catch {
      // 目录不存在是常态（还没存过任何脚本），不是错误
      return [];
    }
  }

  /** 删除配置目录里的一个文件 */
  async removeProjectConfigFile(relPath: string): Promise<void> {
    const abs = this.resolveProjectConfigPath(relPath);
    if (!abs) return;
    try {
      await fs.rm(abs, { force: true });
    } catch {
      // 已经不在就算了
    }
  }

  setRoot(root: string, opts?: { silent?: boolean }): string {
    this.backend = new LocalFsBackend(root);
    this.kind = 'local';
    this.label = root;
    this.startWatcher(root);
    if (!opts?.silent) this.emit();
    return this.backend.root;
  }

  setRemoteBackend(backend: WorkspaceBackend, label: string): string {
    this.stopWatcher();
    this.backend = backend;
    this.kind = 'ssh';
    this.label = label;
    this.emit();
    return backend.root;
  }

  clearRemote(): void {
    this.stopWatcher();
    this.backend = null;
    this.kind = 'local';
    this.label = '未打开工作区';
    this.emit();
  }

  requireRoot(): string {
    if (!this.backend) throw new Error('No workspace open');
    return this.backend.root;
  }

  requireBackend(): WorkspaceBackend {
    if (!this.backend) throw new Error('No workspace open');
    return this.backend;
  }

  async listDir(relPath = '.'): Promise<FileTreeNode[]> {
    const backend = this.requireBackend();
    const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.', '..']);

    /** Compact-merge: collapse single-child-dir chains like VS Code. */
    async function compact(name: string, p: string): Promise<{ name: string; path: string }> {
      let curName = name;
      let curPath = p;
      for (let i = 0; i < 8; i++) {
        let children: { name: string; isDirectory: boolean }[];
        try {
          children = await backend.listDir(curPath);
        } catch {
          break;
        }
        const visible = children.filter((c) => !SKIP.has(c.name));
        // Only merge when there is exactly ONE visible entry and it's a directory
        if (visible.length === 1 && visible[0].isDirectory) {
          curName = `${curName} / ${visible[0].name}`;
          curPath = `${curPath}/${visible[0].name}`;
        } else {
          break;
        }
      }
      return { name: curName, path: curPath };
    }

    let entries: { name: string; isDirectory: boolean }[] = [];
    try {
      entries = await backend.listDir(relPath);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        electronLog.debug(`[workspace] listDir path not found "${relPath}"`);
      } else {
        electronLog.error(`[workspace] listDir failed for "${relPath}":`, err);
      }
      return [];
    }
    const nodes: FileTreeNode[] = [];
    for (const entry of entries) {
      if (!entry.name || SKIP.has(entry.name) || entry.name === '.' || entry.name === '..') continue;

      let childPath =
        !relPath || relPath === '.' ? entry.name : `${relPath.replace(/\/$/, '')}/${entry.name}`;
      childPath = childPath.replace(/\\/g, '/');

      let displayName = entry.name;

      if (entry.isDirectory && this.kind === 'local') {
        const result = await compact(displayName, childPath);
        displayName = result.name;
        childPath = result.path;
      }

      nodes.push({
        name: displayName,
        path: childPath,
        isDirectory: entry.isDirectory,
      });
    }
    return nodes.sort(
      (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
    );
  }

  async readFile(relPath: string): Promise<string> {
    // If it's an absolute path that exists on the local machine (e.g. pyright typeshed-fallback, node_modules stubs, local virtualenv, etc.)
    if (path.isAbsolute(relPath)) {
      try {
        return await fs.readFile(relPath, 'utf8');
      } catch {
        // if not found locally, proceed to backend
      }
    }
    return this.requireBackend().readFile(relPath);
  }

  async readFileDataUrl(relPath: string): Promise<string> {
    const backend = this.requireBackend();
    const buf =
      (await backend.readFileBuffer?.(relPath)) ??
      Buffer.from(await backend.readFile(relPath), 'binary');
    const MAX = 25 * 1024 * 1024;
    if (buf.length > MAX) {
      throw new Error(`图片过大（>${Math.round(MAX / 1024 / 1024)}MB），无法预览`);
    }
    const mime = mimeFromPath(relPath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    await this.requireBackend().writeFile(relPath, content);
    this.notifyFsChange('create', relPath);
  }

  async mkdir(relPath: string): Promise<void> {
    await this.requireBackend().mkdir(relPath);
    this.notifyFsChange('create', relPath);
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.requireBackend().rename(fromRel, toRel);
    this.notifyFsChange('rename', toRel);
  }

  async remove(relPath: string): Promise<void> {
    await this.requireBackend().remove(relPath);
    this.notifyFsChange('delete', relPath);
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    await this.requireBackend().copy(fromRel, toRel);
    this.notifyFsChange('create', toRel);
  }

  async exists(relPath: string): Promise<boolean> {
    if (!this.backend) return false;
    try {
      return await this.backend.exists(relPath);
    } catch {
      return false;
    }
  }

  resolveAbsolute(relPath = '.'): string {
    return this.requireBackend().resolveAbsolute(relPath);
  }
}
