import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import electronLog from 'electron-log';
import type { FileTreeNode, WorkspaceInfo, WorkspaceKind } from '@deepseek-ide/shared';
import { LocalFsBackend, type WorkspaceBackend } from '@deepseek-ide/tools';

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
