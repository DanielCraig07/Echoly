import { shell, BrowserWindow, type IpcMain, type Dialog, type WebContents } from 'electron';
import fs from 'node:fs';
import type {
  AppMenuId,
  AppSettings,
  ChatSession,
  GitCloneRequest,
  GitStashAction,
  SearchCodeRequest,
  SshConnectRequest,
  TerminalCreateOptions,
} from '@deepseek-ide/shared';
import type { SettingsStore } from './settings';
import type { SessionStore } from './sessions';
import type { AgentService } from './agentService';
import type { TerminalService } from './terminal';
import type { GitService } from './gitService';
import type { SearchService } from './searchService';
import type { SshSessionManager } from './ssh/SshSessionManager';
import type { WindowRegistry } from './windowRegistry';
import { detectMavenEnvironment, initMavenWrapper, initMavenSettings } from './mavenService';
import { detectInstalledJdks, getAvailableOnlineJdks, installOnlineJdk } from './javaService';

export function registerIpc(deps: {
  ipcMain: IpcMain;
  dialog: Dialog;
  settings: SettingsStore;
  sessions: SessionStore;
  registry: WindowRegistry;
  agents: AgentService;
  terminals: TerminalService;
  git: GitService;
  search: SearchService;
  ssh: SshSessionManager;
  getWindow: () => BrowserWindow | null;
  popupAppMenu: (id: AppMenuId, win: BrowserWindow) => void;
  onSettingsChanged?: () => void;
}): void {
  const {
    ipcMain,
    dialog,
    settings,
    sessions,
    registry,
    agents,
    terminals,
    git,
    search,
    ssh,
    getWindow,
    popupAppMenu,
    onSettingsChanged,
  } = deps;

  const windowFromEvent = (event: { sender: WebContents }): BrowserWindow | null =>
    BrowserWindow.fromWebContents(event.sender) ?? getWindow();

  const run = <T>(event: { sender: WebContents }, fn: () => T): T => registry.run(event.sender, fn);

  const sshAuthHandoffMap = new Map<string, any>();

  ipcMain.handle('window:openNew', async (_e, targetPath?: string, sshAuth?: any) => {
    const { createWindow } = await import('./index');
    let token: string | undefined;
    if (sshAuth) {
      const { randomUUID } = await import('node:crypto');
      token = randomUUID();
      sshAuthHandoffMap.set(token, sshAuth);
      setTimeout(() => {
        if (token) sshAuthHandoffMap.delete(token);
      }, 60_000);
    }
    // Blank window + optional ?workspace=; each window has its own WorkspaceService.
    createWindow(targetPath, { blank: true, sshAuthToken: token });
  });

  ipcMain.handle('ssh:getAuthHandoff', (_e, token: string) => {
    if (!token) return null;
    const data = sshAuthHandoffMap.get(token);
    if (data) {
      sshAuthHandoffMap.delete(token);
      return data;
    }
    return null;
  });

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:save', (_e, partial: Partial<AppSettings>) => {
    const next = settings.save(partial);
    onSettingsChanged?.();
    return next;
  });

  ipcMain.handle('workspace:pick', async (event) =>
    run(event, async () => {
      const win = windowFromEvent(event);
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    }),
  );

  ipcMain.handle('workspace:get', (event) =>
    run(event, () => registry.current().workspace.getRoot()),
  );
  ipcMain.handle('workspace:getInfo', (event) =>
    run(event, () => registry.current().workspace.getInfo()),
  );
  ipcMain.handle('workspace:set', (event, root: string) =>
    run(event, () => registry.current().workspace.setRoot(root)),
  );
  ipcMain.handle('workspace:listDir', (event, relPath?: string) =>
    run(event, () => registry.current().workspace.listDir(relPath)),
  );
  ipcMain.handle('workspace:readFile', (event, relPath: string) =>
    run(event, () => registry.current().workspace.readFile(relPath)),
  );
  ipcMain.handle('workspace:readFileDataUrl', (event, relPath: string) =>
    run(event, () => registry.current().workspace.readFileDataUrl(relPath)),
  );
  ipcMain.handle('workspace:writeFile', (event, relPath: string, content: string) =>
    run(event, async () => {
      await registry.current().workspace.writeFile(relPath, content);
      search.invalidateCache();
    }),
  );
  ipcMain.handle('workspace:mkdir', (event, relPath: string) =>
    run(event, async () => {
      await registry.current().workspace.mkdir(relPath);
      search.invalidateCache();
    }),
  );
  ipcMain.handle('workspace:rename', (event, fromRel: string, toRel: string) =>
    run(event, async () => {
      await registry.current().workspace.rename(fromRel, toRel);
      search.invalidateCache();
    }),
  );
  ipcMain.handle('workspace:remove', (event, relPath: string) =>
    run(event, async () => {
      await registry.current().workspace.remove(relPath);
      search.invalidateCache();
    }),
  );
  ipcMain.handle('workspace:copy', (event, fromRel: string, toRel: string) =>
    run(event, async () => {
      await registry.current().workspace.copy(fromRel, toRel);
      search.invalidateCache();
    }),
  );
  ipcMain.handle('workspace:exists', (event, relPath: string) =>
    run(event, () => registry.current().workspace.exists(relPath)),
  );
  ipcMain.handle('workspace:resolveAbsolute', (event, relPath?: string) =>
    run(event, () => registry.current().workspace.resolveAbsolute(relPath)),
  );
  ipcMain.handle('workspace:downloadFile', async (event, relPath: string) =>
    run(event, async () => {
      const win = windowFromEvent(event);
      const workspace = registry.current().workspace;
      const baseName = relPath.replace(/\\/g, '/').split('/').pop() || 'download';
      const result = await dialog.showSaveDialog(win!, { defaultPath: baseName });
      if (result.canceled || !result.filePath) return null;
      const dest = result.filePath;
      const backend = workspace.requireBackend();
      if (backend.kind === 'local') {
        fs.copyFileSync(backend.resolveAbsolute(relPath), dest);
      } else {
        const buf =
          (await backend.readFileBuffer?.(relPath)) ??
          Buffer.from(await backend.readFile(relPath), 'utf8');
        fs.writeFileSync(dest, buf);
      }
      return dest;
    }),
  );

  ipcMain.handle('dialog:saveFile', async (event, defaultPath?: string) => {
    const win = windowFromEvent(event);
    const result = await dialog.showSaveDialog(win!, { defaultPath });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('dialog:pickDirectory', async (event) => {
    const win = windowFromEvent(event);
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    'dialog:pickFile',
    async (event, filters?: { name: string; extensions: string[] }[]) => {
      const win = windowFromEvent(event);
      const result = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        filters: filters || [],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    },
  );

  ipcMain.handle('agent:start', (e, payload) => run(e, () => agents.start(payload, e.sender)));
  ipcMain.handle('agent:cancel', (_e, runId: string) => agents.cancel(runId));
  ipcMain.handle(
    'agent:respondConfirm',
    (_e, requestId: string, approved: boolean, answer?: string) =>
      agents.respondConfirm(requestId, approved, answer),
  );
  ipcMain.handle('agent:continue', (_e, runId: string) => agents.continueAgent(runId));
  ipcMain.handle('agent:stopContinue', (_e, runId: string) => agents.stopContinueAgent(runId));
  ipcMain.handle('agent:probe', (_e, options) => agents.probe(options));
  ipcMain.handle('skills:list', (e) => run(e, () => agents.listSkills()));
  ipcMain.handle('skills:openUserDir', async () => {
    const dir = agents.openUserSkillsDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });
  ipcMain.handle('shell:showItemInFolder', (_e, fullPath: string) => {
    shell.showItemInFolder(fullPath);
  });

  ipcMain.handle('diff:accept', (e, id: string) =>
    run(e, () => registry.current().diffs.accept(id)),
  );
  ipcMain.handle('diff:reject', (e, id: string) =>
    run(e, () => {
      registry.current().diffs.reject(id);
    }),
  );
  ipcMain.handle('diff:acceptAll', (e) => run(e, () => registry.current().diffs.acceptAll()));

  ipcMain.handle('session:list', () => sessions.list());
  ipcMain.handle('session:get', (_e, id: string) => sessions.get(id));
  ipcMain.handle('session:save', (_e, session: ChatSession) => sessions.save(session));
  ipcMain.handle('session:delete', (_e, id: string) => sessions.delete(id));

  ipcMain.handle('git:clone', (e, req: GitCloneRequest) => run(e, () => git.clone(req)));
  ipcMain.handle('git:status', (e) => run(e, () => git.status()));
  ipcMain.handle('git:init', (e) => run(e, () => git.init()));
  ipcMain.handle('git:stage', (e, paths: string[]) => run(e, () => git.stage(paths)));
  ipcMain.handle('git:unstage', (e, paths: string[]) => run(e, () => git.unstage(paths)));
  ipcMain.handle('git:commit', (e, message: string, amend?: boolean) =>
    run(e, () => git.commit(message, amend)),
  );
  ipcMain.handle('git:discard', (e, paths: string[]) => run(e, () => git.discard(paths)));
  ipcMain.handle('git:diff', (e, path: string, staged?: boolean) =>
    run(e, () => git.diff(path, staged)),
  );
  ipcMain.handle('git:branches', (e) => run(e, () => git.branches()));
  ipcMain.handle('git:checkout', (e, branch: string) => run(e, () => git.checkout(branch)));
  ipcMain.handle('git:createBranch', (e, name: string, checkout?: boolean) =>
    run(e, () => git.createBranch(name, checkout)),
  );
  ipcMain.handle('git:pull', (e) => run(e, () => git.pull()));
  ipcMain.handle('git:push', (e) => run(e, () => git.push()));
  ipcMain.handle('git:fetch', (e) => run(e, () => git.fetch()));
  ipcMain.handle('git:remotes', (e) => run(e, () => git.remotes()));
  ipcMain.handle('git:stash', (e, action, message?) => run(e, () => git.stash(action, message)));
  ipcMain.handle('git:tags', (e) => run(e, () => git.tags()));
  ipcMain.handle('git:createTag', (e, name: string, message?: string) =>
    run(e, () => git.createTag(name, message)),
  );
  ipcMain.handle('git:output', (e, maxCount?: number) => run(e, () => git.output(maxCount)));
  ipcMain.handle('git:history', (e, maxCount?: number) => run(e, () => git.history(maxCount)));
  ipcMain.handle('git:commitDetails', (e, hash: string) => run(e, () => git.commitDetails(hash)));
  ipcMain.handle('git:fileHistory', (e, path: string, maxCount?: number) =>
    run(e, () => git.fileHistory(path, maxCount)),
  );
  ipcMain.handle('git:blameLine', (e, path: string, line: number) =>
    run(e, () => git.blameLine(path, line)),
  );
  ipcMain.handle('git:showCommitDiff', (e, hash: string, path: string) =>
    run(e, () => git.showCommitDiff(hash, path)),
  );

  ipcMain.handle('search:files', (e, query: string, max?: number) =>
    run(e, () => search.searchFiles(query, max)),
  );
  ipcMain.handle('search:code', (e, req: SearchCodeRequest) =>
    run(e, () => search.searchCode(req)),
  );

  ipcMain.handle('ssh:connect', (e, req: SshConnectRequest) => run(e, () => ssh.connect(req)));
  ipcMain.handle('ssh:disconnect', (e) => run(e, () => ssh.disconnect()));
  ipcMain.handle('ssh:disconnectBrowse', (e) => run(e, () => ssh.disconnectBrowse()));
  ipcMain.handle('ssh:switchRemotePath', (e, remotePath: string) =>
    run(e, () => ssh.switchRemotePath(remotePath)),
  );
  ipcMain.handle('ssh:getActiveSession', (e) => run(e, () => ssh.getActiveSession()));
  ipcMain.handle('ssh:listProfiles', () => ssh.listProfiles());
  ipcMain.handle('ssh:listLocalConfig', () => ssh.listLocalConfig());
  ipcMain.handle('ssh:saveProfile', (_e, profile) => ssh.saveProfile(profile));
  ipcMain.handle('ssh:deleteProfile', (_e, id: string) => ssh.deleteProfile(id));
  ipcMain.handle('ssh:listRemoteDir', (e, remotePath?: string) =>
    run(e, () => ssh.listRemoteDir(remotePath)),
  );

  ipcMain.handle('terminal:create', (e, options?: TerminalCreateOptions) =>
    run(e, () => terminals.create(options, e.sender.id)),
  );
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    terminals.resize(id, cols, rows),
  );
  ipcMain.handle('terminal:dispose', (_e, id: string) => terminals.dispose(id));

  ipcMain.handle('menu:popup', (event, id: AppMenuId) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow();
    if (!win || win.isDestroyed()) return;
    popupAppMenu(id, win);
  });

  ipcMain.handle('lsp:getDefinition', (e, filePath: string, line: number, column: number) =>
    run(e, () => registry.current().lsp.getDefinition(filePath, line, column)),
  );
  ipcMain.handle(
    'lsp:notifyDocument',
    (e, filePath: string, content: string, languageId?: string) =>
      run(e, () => registry.current().lsp.notifyDocument(filePath, content, languageId)),
  );

  ipcMain.handle('maven:checkEnv', (e) =>
    run(e, () => detectMavenEnvironment(registry.current().workspace.getRoot() ?? undefined)),
  );
  ipcMain.handle('maven:initWrapper', (e) =>
    run(e, () => {
      const root = registry.current().workspace.getRoot();
      if (!root) {
        return { success: false, message: '未打开工作区' };
      }
      return initMavenWrapper(root);
    }),
  );
  ipcMain.handle('maven:initSettings', (e) =>
    run(e, () => {
      const root = registry.current().workspace.getRoot();
      if (!root) {
        return { success: false, message: '未打开工作区' };
      }
      return initMavenSettings(root);
    }),
  );

  ipcMain.handle('java:listInstalled', (e) =>
    run(e, () => detectInstalledJdks()),
  );
  ipcMain.handle('java:listOnline', (e) =>
    run(e, () => getAvailableOnlineJdks()),
  );
  ipcMain.handle('java:installOnline', (e, id: string) =>
    run(e, () => installOnlineJdk(id)),
  );

  ipcMain.handle('system:openPrivacySettings', async (_e, type?: string) => {
    if (process.platform === 'darwin') {
      try {
        if (type === 'localNetwork') {
          await shell.openExternal(
            'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
          );
          return true;
        }
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security');
        return true;
      } catch {
        return false;
      }
    }
    return false;
  });
}
