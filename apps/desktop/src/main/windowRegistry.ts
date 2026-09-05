import { AsyncLocalStorage } from 'node:async_hooks';
import { BrowserWindow, type WebContents } from 'electron';
import { WorkspaceService } from './workspace';
import { DiffStore } from './diffStore';

/** Per-BrowserWindow workspace + diffs (multi-window isolation). */
export class WindowSession {
  readonly workspace = new WorkspaceService();
  readonly diffs = new DiffStore(this.workspace);

  constructor(readonly webContentsId: number) {}
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
    session.workspace.setChangeListener((info) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && w.webContents.id === id,
      );
      if (win) win.webContents.send('workspace:changed', info);
    });
    wc.once('destroyed', () => {
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
