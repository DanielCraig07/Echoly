import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import electronLog from 'electron-log';
import type { FileTreeNode, WorkspaceInfo, WorkspaceKind } from '@deepseek-ide/shared';
import { NO_WORKSPACE_LABEL } from '@deepseek-ide/shared';
import { LocalFsBackend, type WorkspaceBackend } from '@deepseek-ide/tools';
import {
  findFolder,
  makeFolderId,
  normalizeFolders,
  parseLogicalPath,
  toLogicalPath,
  type WorkspaceFolder,
} from './workspaceFolders';
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
  private label = NO_WORKSPACE_LABEL;
  private onChange: ((info: WorkspaceInfo) => void) | null = null;
  private onFsChange: ((data: { type: string; path?: string }) => void) | null = null;
  private watcher: fsSync.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  /**
   * 附加文件夹（多根工作区）。
   *
   * 它们是**主根之外**的目录，通过逻辑前缀 `multiroot:<id>/...` 编址，
   * 在 `backendFor()` 这一个入口被解析。所有文件操作都过那里，
   * 所以文件树、打开/保存这些既有链路不需要各自知道多根的存在。
   */
  private folders: WorkspaceFolder[] = [];
  /** 每个附加文件夹一个 backend 与一个 watcher，按 id 缓存。 */
  private folderBackends = new Map<string, WorkspaceBackend>();
  private folderWatchers = new Map<string, fsSync.FSWatcher>();

  /**
   * 项目配置目录所用的「家目录」。**只为测试而存在**：默认走 `os.homedir()`，
   * 但没有它就没法在测试里跑真实文件操作 —— 那会往用户真正的 `~/.echoly/` 里写东西。
   * `projectConfig*` 那组函数本来就是收 `homeDir` 参数的，这里只是把它透传上来。
   */
  private readonly configHomeDir?: string;

  constructor(opts: { configHomeDir?: string } = {}) {
    this.configHomeDir = opts.configHomeDir;
  }

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
      folders: this.folders.map((folder) => ({
        id: folder.id,
        label: folder.label,
        path: toLogicalPath(folder.id),
        absPath: folder.absPath,
      })),
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

  // ── 多根：附加文件夹 ────────────────────────────────────────────────────

  getFolders(): WorkspaceFolder[] {
    return this.folders.slice();
  }

  /** 丢掉全部附加文件夹（backend、watcher、缓存）。换工作区 / 关工作区时调用。 */
  private resetFolders(): void {
    this.stopAllFolderWatchers();
    this.folderBackends.clear();
    this.folders = [];
  }

  /**
   * 解析一个逻辑路径到「哪个 backend 的哪个相对路径」。
   *
   * **找不到对应文件夹时抛错，而不是退回主根**：退回去的后果是把内容写到主根下
   * 一个同名的、看起来正常的文件里 —— 用户会以为写对了。宁可让这次操作明确失败。
   */
  private backendFor(input: string): { backend: WorkspaceBackend; rel: string } {
    const { folderId, rel } = parseLogicalPath(input);
    if (!folderId) return { backend: this.requireBackend(), rel };

    const folder = findFolder(this.folders, folderId);
    if (!folder) {
      throw new Error(`附加文件夹已不存在：${folderId}（可能已被移除，请刷新文件树）`);
    }
    return { backend: this.folderBackend(folder), rel };
  }

  private folderBackend(folder: WorkspaceFolder): WorkspaceBackend {
    let backend = this.folderBackends.get(folder.id);
    if (!backend) {
      backend = new LocalFsBackend(folder.absPath);
      this.folderBackends.set(folder.id, backend);
    }
    return backend;
  }

  /**
   * 设置附加文件夹列表。
   *
   * 传进来的是绝对路径；已移除的文件夹要连 backend 与 watcher 一起丢掉，
   * 否则换回同一个目录时会拿到一个指向旧路径的缓存实例。
   */
  async setFolders(absPaths: readonly string[]): Promise<WorkspaceFolder[]> {
    const previous = this.folders;
    // 保留既有 id：逻辑路径里带着 id，重新计算会让已经打开的标签页指向不存在的文件夹
    const folders = normalizeFolders(
      absPaths.map((absPath) => {
        const existing = previous.find((f) => f.absPath === path.resolve(absPath));
        return existing ?? { id: makeFolderId(absPath), label: path.basename(absPath), absPath };
      }),
    );

    this.folders = folders;
    this.syncFolderWatchers(previous);

    await this.persistFolders();
    this.emit();
    return folders;
  }

  private syncFolderWatchers(previous: readonly WorkspaceFolder[]): void {
    for (const folder of previous) {
      if (this.folders.some((f) => f.id === folder.id)) continue;
      this.stopFolderWatcher(folder.id);
      this.folderBackends.delete(folder.id);
    }
    for (const folder of this.folders) {
      if (this.folderWatchers.has(folder.id)) continue;
      this.startFolderWatcher(folder);
    }
  }

  /**
   * 附加文件夹的变更监听。
   *
   * 事件里的 filename 是**相对该文件夹**的，要重新拼成逻辑路径再广播 ——
   * 直接发原样会让渲染层去主根下找这个文件（找不到，而且不会报错，只是不刷新）。
   */
  private startFolderWatcher(folder: WorkspaceFolder): void {
    if (!fsSync.existsSync(folder.absPath)) return;
    try {
      const watcher = fsSync.watch(folder.absPath, { recursive: true }, (_event, filename) => {
        const rel = filename ? String(filename).replace(/\\/g, '/') : undefined;
        this.notifyFsChange(
          'watch',
          rel ? toLogicalPath(folder.id, rel) : toLogicalPath(folder.id),
        );
      });
      watcher.on('error', (err) => {
        electronLog.warn('[workspace] 附加文件夹 watcher 出错:', err);
      });
      this.folderWatchers.set(folder.id, watcher);
    } catch (e) {
      electronLog.warn('[workspace] 无法监听附加文件夹', folder.absPath, e);
    }
  }

  private stopFolderWatcher(id: string): void {
    const watcher = this.folderWatchers.get(id);
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // 关不掉就算了，不该影响移除文件夹这件事本身
    }
    this.folderWatchers.delete(id);
  }

  private stopAllFolderWatchers(): void {
    for (const id of [...this.folderWatchers.keys()]) this.stopFolderWatcher(id);
  }

  private async persistFolders(): Promise<void> {
    try {
      await this.writeProjectConfigFile(
        'workspace-folders.json',
        JSON.stringify({ folders: this.folders.map((f) => f.absPath) }, null, 2),
      );
    } catch {
      // 记不住附加文件夹不影响本次会话，只是下次打开要重新加
    }
  }

  /** 从项目配置里恢复附加文件夹。打开工作区后调用一次。 */
  async loadFolders(): Promise<void> {
    this.folders = [];
    this.folderBackends.clear();
    this.stopAllFolderWatchers();

    const raw = await this.readProjectConfigFile('workspace-folders.json');
    if (!raw) {
      this.emit();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { folders?: unknown };
      const list = Array.isArray(parsed.folders)
        ? parsed.folders.filter((f): f is string => typeof f === 'string')
        : [];
      // 不存在的目录直接丢掉：磁盘被清掉之后留着一条死路径，展开时才报错更难懂
      const alive = list.filter((absPath) => fsSync.existsSync(absPath));
      this.folders = normalizeFolders(
        alive.map((absPath) => ({
          id: makeFolderId(absPath),
          label: path.basename(absPath),
          absPath,
        })),
      );
      this.syncFolderWatchers([]);
    } catch {
      electronLog.warn('[workspace] workspace-folders.json 解析失败，已忽略');
    }
    this.emit();
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
    return projectConfigChildPath(root, relPath, this.configHomeDir);
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
    // 换工作区 = 换主根，上一份附加文件夹与它的 watcher 都作废
    // （`loadFolders()` 会在打开工作区之后把持久化的那份加载回来）。
    this.resetFolders();
    this.backend = new LocalFsBackend(root);
    this.kind = 'local';
    this.label = root;
    this.startWatcher(root);
    if (!opts?.silent) this.emit();
    return this.backend.root;
  }

  setRemoteBackend(backend: WorkspaceBackend, label: string): string {
    this.stopWatcher();
    // 多根目前只支持本地工作区：SSH 后端下附加本地文件夹会让两套寻址搅在一起，
    // 与其半支持不如明确不支持（附加文件夹只在本地模式下有意义）。
    this.resetFolders();
    this.backend = backend;
    this.kind = 'ssh';
    this.label = label;
    this.emit();
    return backend.root;
  }

  clearRemote(): void {
    this.stopWatcher();
    this.resetFolders();
    this.backend = null;
    this.kind = 'local';
    this.label = NO_WORKSPACE_LABEL;
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
    // 逻辑前缀在**这里**解掉：附加文件夹有自己的 backend，之后的相对路径都相对它。
    const { folderId } = parseLogicalPath(relPath);
    const { backend, rel: baseRel } = this.backendFor(relPath);
    const SKIP = new Set(['node_modules', '.git', '.DS_Store', '.', '..']);

    const isSsh = this.kind === 'ssh' && !folderId;
    // 远程 SSH 模式下将紧凑合并深度降为 1，杜绝批量 SFTP 串行等待造成的展开卡顿
    const maxCompactDepth = isSsh ? 1 : 6;

    /**
     * 把「相对某个 backend 的路径」还原成渲染层使用的逻辑路径。
     *
     * 附加文件夹的节点**必须**带前缀回给渲染层：后续展开、打开、保存都拿这个
     * 字符串回来，丢了前缀就会被当成主根下的路径。
     */
    const toDisplayPath = (backendRel: string): string =>
      folderId ? toLogicalPath(folderId, backendRel) : backendRel;

    /** Compact-merge: collapse single-child-dir chains like VS Code. */
    async function compact(name: string, p: string): Promise<{ name: string; path: string }> {
      let curName = name;
      let curPath = p;
      for (let i = 0; i < maxCompactDepth; i++) {
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
      entries = await backend.listDir(baseRel);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        electronLog.debug(`[workspace] listDir path not found "${relPath}"`);
      } else {
        electronLog.error(`[workspace] listDir failed for "${relPath}":`, err);
      }
      return [];
    }

    const rawNodes = await Promise.all(
      entries.map(async (entry) => {
        if (!entry.name || SKIP.has(entry.name) || entry.name === '.' || entry.name === '..')
          return null;

        let childRel =
          !baseRel || baseRel === '.' ? entry.name : `${baseRel.replace(/\/$/, '')}/${entry.name}`;
        childRel = childRel.replace(/\\/g, '/');

        let displayName = entry.name;

        if (entry.isDirectory) {
          const result = await compact(displayName, childRel);
          displayName = result.name;
          childRel = result.path;
        }

        return {
          name: displayName,
          path: toDisplayPath(childRel),
          isDirectory: entry.isDirectory,
        };
      }),
    );
    const nodes = rawNodes.filter(Boolean) as FileTreeNode[];

    // 主根这一层的额外节点：每个附加文件夹当做一个顶层目录挂上去。
    // 只挂给主根，附加文件夹自己的子树里不该再出现它们（否则是无限递归的观感）。
    if (!folderId && (!baseRel || baseRel === '.')) {
      for (const folder of this.folders) {
        nodes.push({
          name: folder.label,
          path: toLogicalPath(folder.id),
          isDirectory: true,
        });
      }
    }

    return nodes.sort(
      (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
    );
  }

  /**
   * 读取工作区内的文件。
   *
   * 这里**曾有一条绝对路径旁路**（注释说为了 pyright typeshed / node_modules stub），
   * 但全仓没有任何调用方需要它，而 `workspace:readFile` 是渲染层可直接触发的 IPC ——
   * 等于把「读本机任意文件」暴露成一条公用的读接口。真需要读工作区外的文件时，
   * 应该走 `readProjectConfigFile` 那种按用途命名的专用通道，而不是把 jail 拆掉。
   */
  async readFile(relPath: string): Promise<string> {
    const { backend, rel } = this.backendFor(relPath);
    return backend.readFile(rel);
  }

  async readFileLines(
    relPath: string,
    offset?: number,
    limit?: number,
  ): Promise<{ lines: string[]; total: number; offset: number; truncated: boolean }> {
    const { backend, rel } = this.backendFor(relPath);
    return backend.readFileLines(rel, offset, limit);
  }

  async readFileDataUrl(relPath: string): Promise<string> {
    const { backend, rel } = this.backendFor(relPath);
    const buf =
      (await backend.readFileBuffer?.(rel)) ?? Buffer.from(await backend.readFile(rel), 'binary');
    const MAX = 25 * 1024 * 1024;
    if (buf.length > MAX) {
      throw new Error(`图片过大（>${Math.round(MAX / 1024 / 1024)}MB），无法预览`);
    }
    // MIME 只取决于扩展名，逻辑前缀不影响判断，所以传原始路径
    const mime = mimeFromPath(relPath);
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const { backend, rel } = this.backendFor(relPath);
    await backend.writeFile(rel, content);
    // 广播时用**原始逻辑路径**：监听方拿它去刷新文件树，前缀必须留着。
    this.notifyFsChange('create', relPath);
  }

  async mkdir(relPath: string): Promise<void> {
    const { backend, rel } = this.backendFor(relPath);
    await backend.mkdir(rel);
    this.notifyFsChange('create', relPath);
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    // 跨文件夹改名不做「搬运」：两个 backend 之间只有本地文件系统能搬，
    // 而附加文件夹的语义是「并列的独立根」，把内容挪到另一个根下面容易误会。
    // 真要合并内容，用户走资源管理器的复制/粘贴更清楚。
    const from = this.backendFor(fromRel);
    const to = this.backendFor(toRel);
    if (from.backend !== to.backend) {
      throw new Error('暂不支持在不同工作区文件夹之间移动文件');
    }
    await from.backend.rename(from.rel, to.rel);
    this.notifyFsChange('rename', toRel);
  }

  async remove(relPath: string): Promise<void> {
    const { backend, rel } = this.backendFor(relPath);
    await backend.remove(rel);
    this.notifyFsChange('delete', relPath);
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    const from = this.backendFor(fromRel);
    const to = this.backendFor(toRel);
    if (from.backend !== to.backend) {
      throw new Error('暂不支持在不同工作区文件夹之间复制文件');
    }
    await from.backend.copy(from.rel, to.rel);
    this.notifyFsChange('create', toRel);
  }

  async exists(relPath: string): Promise<boolean> {
    if (!this.backend) return false;
    try {
      const { backend, rel } = this.backendFor(relPath);
      return await backend.exists(rel);
    } catch {
      return false;
    }
  }

  resolveAbsolute(relPath = '.'): string {
    const { folderId } = parseLogicalPath(relPath);
    if (!folderId) return this.requireBackend().resolveAbsolute(relPath);
    // 附加文件夹里的路径有确切的本地绝对路径，照样给得出（用在「在访达中显示」这类地方）
    const { backend, rel } = this.backendFor(relPath);
    return backend.resolveAbsolute(rel);
  }
}
