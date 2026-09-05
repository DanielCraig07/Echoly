import { contextBridge, ipcRenderer } from 'electron';
import type {
  AgentEvent,
  AppSettings,
  ChatSession,
  GitCloneRequest,
  IpcApi,
  AppMenuId,
  MenuCommand,
  SearchCodeRequest,
  SshConnectRequest,
  TerminalCreateOptions,
  WorkspaceInfo,
} from '@deepseek-ide/shared';
import { exposeExtensionAPI } from './extensionBridge';

const api: IpcApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openNewWindow: (targetPath) => ipcRenderer.invoke('window:openNew', targetPath),
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  getWorkspaceInfo: () => ipcRenderer.invoke('workspace:getInfo'),
  setWorkspace: (root) => ipcRenderer.invoke('workspace:set', root),
  listDir: (relPath) => ipcRenderer.invoke('workspace:listDir', relPath),
  readFile: (relPath) => ipcRenderer.invoke('workspace:readFile', relPath),
  readFileDataUrl: (relPath) => ipcRenderer.invoke('workspace:readFileDataUrl', relPath),
  writeFile: (relPath, content) => ipcRenderer.invoke('workspace:writeFile', relPath, content),
  mkdir: (relPath) => ipcRenderer.invoke('workspace:mkdir', relPath),
  renamePath: (fromRel, toRel) => ipcRenderer.invoke('workspace:rename', fromRel, toRel),
  removePath: (relPath) => ipcRenderer.invoke('workspace:remove', relPath),
  copyPath: (fromRel, toRel) => ipcRenderer.invoke('workspace:copy', fromRel, toRel),
  pathExists: (relPath) => ipcRenderer.invoke('workspace:exists', relPath),
  resolveAbsolutePath: (relPath) => ipcRenderer.invoke('workspace:resolveAbsolute', relPath),
  downloadFile: (relPath) => ipcRenderer.invoke('workspace:downloadFile', relPath),
  saveFileDialog: (defaultPath) => ipcRenderer.invoke('dialog:saveFile', defaultPath),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFile: (filters) => ipcRenderer.invoke('dialog:pickFile', filters),
  startAgent: (payload) => ipcRenderer.invoke('agent:start', payload),
  cancelAgent: (runId) => ipcRenderer.invoke('agent:cancel', runId),
  respondConfirm: (requestId, approved, answer) =>
    ipcRenderer.invoke('agent:respondConfirm', requestId, approved, answer),
  continueAgent: (runId) => ipcRenderer.invoke('agent:continue', runId),
  stopContinueAgent: (runId) => ipcRenderer.invoke('agent:stopContinue', runId),
  acceptDiff: (diffId) => ipcRenderer.invoke('diff:accept', diffId),
  rejectDiff: (diffId) => ipcRenderer.invoke('diff:reject', diffId),
  acceptAllDiffs: () => ipcRenderer.invoke('diff:acceptAll'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSession: (id) => ipcRenderer.invoke('session:get', id),
  saveSession: (session: ChatSession) => ipcRenderer.invoke('session:save', session),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  probeLlm: (options?: { baseUrl?: string; apiKey?: string; model?: string; provider?: string }) =>
    ipcRenderer.invoke('agent:probe', options),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  openUserSkillsDir: () => ipcRenderer.invoke('skills:openUserDir'),
  cloneRepo: (req: GitCloneRequest) => ipcRenderer.invoke('git:clone', req),
  gitInit: () => ipcRenderer.invoke('git:init'),
  gitStatus: () => ipcRenderer.invoke('git:status'),
  gitStage: (paths) => ipcRenderer.invoke('git:stage', paths),
  gitUnstage: (paths) => ipcRenderer.invoke('git:unstage', paths),
  gitCommit: (message, amend) => ipcRenderer.invoke('git:commit', message, amend),
  gitDiscard: (paths) => ipcRenderer.invoke('git:discard', paths),
  gitDiff: (path, staged) => ipcRenderer.invoke('git:diff', path, staged),
  gitBranches: () => ipcRenderer.invoke('git:branches'),
  gitCheckout: (branch) => ipcRenderer.invoke('git:checkout', branch),
  gitCreateBranch: (name, checkout) => ipcRenderer.invoke('git:createBranch', name, checkout),
  gitPull: () => ipcRenderer.invoke('git:pull'),
  gitPush: () => ipcRenderer.invoke('git:push'),
  gitHistory: (maxCount) => ipcRenderer.invoke('git:history', maxCount),
  gitCommitDetails: (hash) => ipcRenderer.invoke('git:commitDetails', hash),
  gitFileHistory: (path, maxCount) => ipcRenderer.invoke('git:fileHistory', path, maxCount),
  gitBlameLine: (path: string, line: number) => ipcRenderer.invoke('git:blameLine', path, line),
  gitShowCommitDiff: (hash, path) => ipcRenderer.invoke('git:showCommitDiff', hash, path),

  searchFiles: (query, max) => ipcRenderer.invoke('search:files', query, max),
  searchCode: (req: SearchCodeRequest) => ipcRenderer.invoke('search:code', req),
  sshConnect: (req: SshConnectRequest) => ipcRenderer.invoke('ssh:connect', req),
  sshDisconnect: () => ipcRenderer.invoke('ssh:disconnect'),
  listSshProfiles: () => ipcRenderer.invoke('ssh:listProfiles'),
  listLocalSshConfig: () => ipcRenderer.invoke('ssh:listLocalConfig'),
  deleteSshProfile: (id) => ipcRenderer.invoke('ssh:deleteProfile', id),
  listRemoteDir: (remotePath?: string) => ipcRenderer.invoke('ssh:listRemoteDir', remotePath),
  createTerminal: (options?: TerminalCreateOptions) =>
    ipcRenderer.invoke('terminal:create', options),
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
  disposeTerminal: (id) => ipcRenderer.invoke('terminal:dispose', id),
  popupMenu: (id: AppMenuId) => ipcRenderer.invoke('menu:popup', id),
  onMenuCommand: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, command: MenuCommand) => cb(command);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
  onAgentEvent: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, event: AgentEvent & { runId: string }) =>
      cb(event);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
  onTerminalData: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
      cb(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: { id: string; exitCode: number }) =>
      cb(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },
  onWorkspaceChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, info: WorkspaceInfo) => cb(info);
    ipcRenderer.on('workspace:changed', listener);
    return () => ipcRenderer.removeListener('workspace:changed', listener);
  },
  onGitCloneLog: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on('git:cloneLog', listener);
    return () => ipcRenderer.removeListener('git:cloneLog', listener);
  },
  onDownloadProgress: (cb) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      progress: { percent: number; downloaded: number; total: number },
    ) => cb(progress);
    ipcRenderer.on('extension:download-progress', listener);
    return () => ipcRenderer.removeListener('extension:download-progress', listener);
  },
  onExtensionWebviewRegistered: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, data: { viewId: string }) => cb(data);
    ipcRenderer.on('extension:webview-registered', listener);
    return () => ipcRenderer.removeListener('extension:webview-registered', listener);
  },
  extensionResolveWebview: (viewId) => ipcRenderer.invoke('extension:resolve-webview', viewId),
  checkUpdate: () => ipcRenderer.invoke('updater:check'),
  getUpdateState: () => ipcRenderer.invoke('updater:getState'),
  onUpdateProgress: (cb) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      progress: { phase: 'download' | 'done'; loaded: number; total: number; percent: number },
    ) => cb(progress);
    ipcRenderer.on('updater:progress', listener);
    return () => ipcRenderer.removeListener('updater:progress', listener);
  },
};

contextBridge.exposeInMainWorld('ide', api);

// 暴露扩展 API
exposeExtensionAPI();

void (null as unknown as AppSettings);
