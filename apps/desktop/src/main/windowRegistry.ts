import { AsyncLocalStorage } from 'node:async_hooks';
import { BrowserWindow, type WebContents } from 'electron';
import { LocalFsBackend } from '@deepseek-ide/tools';
import { WorkspaceService } from './workspace';
import { DiffStore } from './diffStore';
import { LspService } from './lspService';
import { DapService } from './dapService';
import { DatabaseService } from './db/databaseService';
import { PROJECT_META_FILE, buildProjectConfigMeta, projectConfigDir } from './projectConfig';

/**
 * 让数据库服务读写「项目配置目录」而不是工作区。
 *
 * 配置不写进用户的项目里（否则会在文件树、git status、打包脚本遍历里凭空多出一个目录），
 * 而是落在 `~/.echoly/projects/<工作区哈希>/`。但 `DatabaseService` 只认识「相对路径 IO」
 * 这一组接口，所以这里做一层映射：传进来的 `db-connections.json` / `queries/…` 一律
 * 解析到这个本地目录下。
 *
 * 映射是**按调用时刻**取工作区根的，而不是在构造时固定下来：一个窗口从「未打开工作区」
 * 到「打开了某个项目」是运行中发生的事，模式化的构造会把第一次的空根冻结住。
 *
 * 每次调用顺带写一次 `project.json`（内容是项目路径）—— 目录名是哈希，人眼认不出属于
 * 哪个项目，这份便签是用户敢不敢删这个目录的唯一依据。写它是幂等的极少字符，不值得为它
 * 单独拉一条生命周期。
 */
function projectConfigWorkspaceIo(workspace: WorkspaceService) {
  const withRoot = async <T>(
    fn: (io: LocalFsBackend) => Promise<T>,
    fallback: T,
    /** 只读操作不该创建目录：仅仅列出连接列表就落一个目录下来，是「打开文件夹就写主目录」 */
    create: boolean,
  ): Promise<T> => {
    const root = workspace.getRoot();
    if (!root) return fallback;
    const io = new LocalFsBackend(projectConfigDir(root));
    if (!create) return fn(io);
    await io.mkdir('.');
    await io.writeFile(
      PROJECT_META_FILE,
      `${JSON.stringify(buildProjectConfigMeta(root, workspace.getKind()), null, 2)}\n`,
    );
    return fn(io);
  };

  return {
    async exists(relPath: string) {
      return withRoot((io) => io.exists(relPath), false, false);
    },
    async readFile(relPath: string) {
      return withRoot((io) => io.readFile(relPath), '', false);
    },
    async writeFile(relPath: string, content: string) {
      await withRoot(async (io) => {
        await io.writeFile(relPath, content);
      }, undefined, true);
    },
    async mkdir(relPath: string) {
      await withRoot(async (io) => {
        await io.mkdir(relPath);
      }, undefined, true);
    },
  };
}

/** Per-BrowserWindow workspace + diffs (multi-window isolation). */
export class WindowSession {
  readonly workspace = new WorkspaceService();
  readonly diffs = new DiffStore(this.workspace);
  readonly lsp = new LspService(() => this.workspace);
  readonly dap = new DapService(() => this.workspace);
  /**
   * 数据库连接随窗口（= 随工作区 / 项目）走，而非进程级单例。
   *
   * 连接配置不写进工作区，而是落在用户主目录的项目配置目录
   * （`~/.echoly/projects/<工作区哈希>/db-connections.json`），所以服务必须知道当前窗口的
   * 工作区才能定位那份配置；多窗口各开不同项目时，各自的连接池与配置列表互不干扰。
   */
  readonly db = new DatabaseService(() => projectConfigWorkspaceIo(this.workspace));
  constructor(readonly webContentsId: number) {}

  dispose(): void {
    // 配置目录的建立时机由渲染层决定（打开工作区时显式调用），这里只做清理
    this.workspace.dispose();
    this.lsp.dispose();
    this.dap.dispose();
    void this.db.disconnectAll();
  }
}

/**
 * Maps each renderer webContents to its own WorkspaceService / DiffStore.
 * IPC handlers should call `registry.run(event.sender, () => …)` so nested
 * services can resolve the correct session via `registry.current()`.
 */
export class WindowRegistry {
  private readonly sessions = new Map<number, WindowSession>();
  private readonly als = new AsyncLocalStorage<WindowSession>();
  private disposeHook: ((webContentsId: number) => void) | null = null;

  /** e.g. tear down that window's SSH when the renderer is destroyed */
  setSessionDisposeHook(hook: (webContentsId: number) => void): void {
    this.disposeHook = hook;
  }

  forWebContents(wc: WebContents): WindowSession {
    const id = wc.id;
    let session = this.sessions.get(id);
    if (session) return session;

    session = new WindowSession(id);
    this.sessions.set(id, session);
    let lastDbRoot: string | null = session.workspace.getRoot();
    session.workspace.setChangeListener((info) => {
      // 工作区根变了 => 连接归属的项目变了。先断开旧项目的全部连接，再通知渲染层；
      // 否则 A 项目窗口会继续连着 B 项目的库，且出新列表时旧连接会被误标成「已连接」。
      if (info.root !== lastDbRoot) {
        lastDbRoot = info.root;
        void session.db.disconnectAll();
      }
      // 这里刻意**不**预先创建配置目录：打开一个文件夹就往用户主目录里落一个目录太粗暴，
      // 而且绝大多数项目根本没用过数据库面板。目录在第一次真正要写配置时才建起来
      // （projectConfigWorkspaceIo 里每次写入都会确保目录存在）。
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.id === id,
      );
      if (win) win.webContents.send('workspace:changed', info);
    });
    session.workspace.setFsChangeListener((data) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.id === id,
      );
      if (win) win.webContents.send('workspace:fsChanged', data);
    });
    session.dap.on('event', (event) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.id === id,
      );
      if (win) win.webContents.send('dap:event', event);
    });
    session.lsp.on('diagnostics', (diag) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.id === id,
      );
      if (win) win.webContents.send('lsp:diagnostics', diag);
    });
    wc.once('destroyed', () => {
      const s = this.sessions.get(id);
      try {
        s?.dispose();
      } catch {
        // ignore
      }
      this.sessions.delete(id);
      try {
        this.disposeHook?.(id);
      } catch {
        // ignore dispose errors
      }
    });
    return session;
  }

  run<T>(wc: WebContents, fn: () => T): T {
    return this.als.run(this.forWebContents(wc), fn);
  }

  current(): WindowSession {
    const session = this.als.getStore();
    if (!session) {
      throw new Error('No window session in async context');
    }
    return session;
  }

  tryCurrent(): WindowSession | undefined {
    return this.als.getStore();
  }

  /** Prefer ALS, else focused window's session (menus / background). */
  resolve(getFocused: () => BrowserWindow | null): WindowSession {
    const current = this.als.getStore();
    if (current) return current;
    const win = getFocused();
    if (win && !win.isDestroyed()) {
      return this.forWebContents(win.webContents);
    }
    const any = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (any) return this.forWebContents(any.webContents);
    return new WindowSession(-1);
  }
}
