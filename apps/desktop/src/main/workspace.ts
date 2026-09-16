import fs from 'node:fs/promises';
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

  setChangeListener(cb: (info: WorkspaceInfo) => void): void {
    this.onChange = cb;
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
    if (!opts?.silent) this.emit();
    return this.backend.root;
  }

  setRemoteBackend(backend: WorkspaceBackend, label: string): string {
    this.backend = backend;
    this.kind = 'ssh';
    this.label = label;
    this.emit();
    return backend.root;
  }

  clearRemote(): void {
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
    } catch (err) {
      electronLog.error(`[workspace] listDir failed for "${relPath}":`, err);
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
  }

  async mkdir(relPath: string): Promise<void> {
    await this.requireBackend().mkdir(relPath);
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.requireBackend().rename(fromRel, toRel);
  }

  async remove(relPath: string): Promise<void> {
    await this.requireBackend().remove(relPath);
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    await this.requireBackend().copy(fromRel, toRel);
  }

  async exists(relPath: string): Promise<boolean> {
    return this.requireBackend().exists(relPath);
  }

  resolveAbsolute(relPath = '.'): string {
    return this.requireBackend().resolveAbsolute(relPath);
  }
}
