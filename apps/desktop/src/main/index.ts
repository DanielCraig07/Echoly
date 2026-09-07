// Use namespace import to ensure proper electron module loading
import * as electron from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerIpc } from './ipc';
import { initLogging } from './logging';
import { SettingsStore } from './settings';
import { SessionStore } from './sessions';
import { AgentService } from './agentService';
import { TerminalService } from './terminal';
import { GitService } from './gitService';
import { SearchService } from './searchService';
import { SshSessionManager } from './ssh/SshSessionManager';
import { WindowRegistry } from './windowRegistry';
import { initializeExtensionManager, disposeExtensionManager } from './extensionManager';
import { initUpdater, quitAndInstallUpdate } from './updater';
import type { AppMenuId } from '@deepseek-ide/shared';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = electron;
type MenuItemConstructorOptions = electron.MenuItemConstructorOptions;
type ElectronBrowserWindow = electron.BrowserWindow;
type ElectronMenu = electron.Menu;

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

app.setName('Echoly');

// 初始化日志与崩溃上报（最早调用）
initLogging();

// 单实例锁：避免同机同时启动多个生产实例；开发环境下不与已安装的应用冲突
const gotSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else if (app.isPackaged) {
  app.on('second-instance', (_event, _argv, _workingDirectory) => {
    // 另一实例启动时，聚焦已有主窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow: ElectronBrowserWindow | null = null;
const windowRegistry = new WindowRegistry();

function getActiveWindow(): ElectronBrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null;
}

function trackWindow(win: ElectronBrowserWindow): void {
  // Ensure this window has its own workspace session from the start.
  windowRegistry.forWebContents(win.webContents);
  mainWindow = win;
  win.on('focus', () => {
    mainWindow = win;
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = getActiveWindow();
    }
  });
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

function adjustZoom(delta: number): void {
  const win = getActiveWindow();
  if (!win || win.isDestroyed()) return;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, win.webContents.getZoomFactor() + delta));
  win.webContents.setZoomFactor(Number(next.toFixed(2)));
}

function resetZoom(): void {
  const win = getActiveWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.setZoomFactor(1);
}

/** Handle zoom in main process so Monaco/xterm cannot swallow Ctrl+/-/0. */
function registerZoomShortcuts(win: ElectronBrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (!ctrl || input.alt) return;

    const key = input.key;
    const code = input.code;

    // Ctrl+= or Ctrl+Shift+= / Ctrl+Plus / Numpad+
    const zoomIn = key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd';
    // Ctrl+- or Ctrl+_ / Numpad-
    const zoomOut = key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract';
    // Ctrl+0 / Numpad0
    const zoomReset = key === '0' || code === 'Digit0' || code === 'Numpad0';

    if (zoomIn) {
      event.preventDefault();
      adjustZoom(ZOOM_STEP);
      return;
    }
    if (zoomOut) {
      event.preventDefault();
      adjustZoom(-ZOOM_STEP);
      return;
    }
    if (zoomReset) {
      event.preventDefault();
      resetZoom();
    }
  });
}

function resolveAppIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [join(__dirname, '../../resources/icon.png'), join(app.getAppPath(), 'resources/icon.png')];
  return candidates.find((p) => existsSync(p));
}

let isWordWrapEnabled = false;

type MenuDeps = {
  getAutoSave: () => boolean;
  setAutoSave: (enabled: boolean) => void;
  getWordWrap: () => boolean;
  setWordWrap: (enabled: boolean) => void;
};

let menuDeps: MenuDeps = {
  getAutoSave: () => false,
  setAutoSave: () => undefined,
  getWordWrap: () => isWordWrapEnabled,
  setWordWrap: (enabled) => {
    isWordWrapEnabled = enabled;
  },
};

function sendMenuCommand(
  command:
    | { type: 'save' }
    | { type: 'autoSave'; enabled: boolean }
    | { type: 'toggleWordWrap'; enabled: boolean }
    | { type: 'newFile' }
    | { type: 'closeEditor' }
    | { type: 'openWorkspaceModal' }
    | { type: 'openWorkspace'; path: string },
): void {
  const win = getActiveWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('menu:command', command);
}

function fileMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: '新建文本文件',
      // 移除 Cmd+N 加速键：该快捷键被指令面板的「AI: 新建对话会话」占用。
      // 若保留加速键，macOS 原生菜单会在渲染进程 keydown 之前拦截它。
      click: () => sendMenuCommand({ type: 'newFile' }),
    },
    {
      label: '新建窗口',
      accelerator: 'CommandOrControl+Shift+N',
      click: () => {
        createWindow(undefined, { blank: true });
      },
    },
    {
      label: 'New Agents Window',
      accelerator: 'CommandOrControl+Option+N',
      click: () => {
        createWindow(undefined, { blank: true });
      },
    },
    {
      label: '使用配置文件新建窗口',
      submenu: [
        {
          label: 'Default',
          click: () => {
            createWindow(undefined, { blank: true });
          },
        },
      ],
    },
    { type: 'separator' },
    {
      label: '打开...',
      // 移除 Cmd+O 加速键：被指令面板「工作区: 打开或切换工作区目录」占用，
      // 避免原生菜单在渲染进程 keydown 之前拦截。
      click: async () => {
        const win = getActiveWindow();
        if (!win) return;
        const result = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'openDirectory'],
        });
        if (!result.canceled && result.filePaths[0]) {
          sendMenuCommand({ type: 'openWorkspace', path: result.filePaths[0] });
        }
      },
    },
    {
      label: '打开文件夹...',
      click: async () => {
        const win = getActiveWindow();
        if (!win) return;
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        if (!result.canceled && result.filePaths[0]) {
          sendMenuCommand({ type: 'openWorkspace', path: result.filePaths[0] });
        }
      },
    },
    { label: '从文件打开工作区...', click: () => {} },
    { label: '打开最近的文件', submenu: [{ label: '清除最近的文件', click: () => {} }] },
    { type: 'separator' },
    {
      label: '将文件夹添加到工作区...',
      click: () => {
        sendMenuCommand({ type: 'openWorkspaceModal' });
      },
    },
    { label: '将工作区另存为...', click: () => {} },
    { label: '复制工作区', click: () => {} },
    { type: 'separator' },
    {
      label: '保存',
      accelerator: 'CommandOrControl+S',
      click: () => sendMenuCommand({ type: 'save' }),
    },
    { label: '另存为...', accelerator: 'CommandOrControl+Shift+S', click: () => {} },
    { label: '全部保存', accelerator: 'CommandOrControl+Option+S', click: () => {} },
    { type: 'separator' },
    { label: '共享', submenu: [{ label: '在 GitHub 上共享', click: () => {} }] },
    { type: 'separator' },
    {
      label: '自动保存',
      type: 'checkbox',
      checked: menuDeps.getAutoSave(),
      click: (item) => {
        const enabled = !!item.checked;
        menuDeps.setAutoSave(enabled);
        sendMenuCommand({ type: 'autoSave', enabled });
      },
    },
    { type: 'separator' },
    { label: '还原文件', click: () => {} },
    {
      label: '关闭编辑器',
      accelerator: 'CommandOrControl+W',
      click: () => sendMenuCommand({ type: 'closeEditor' }),
    },
    { label: '关闭文件夹', accelerator: 'CommandOrControl+K', click: () => {} },
    {
      label: 'Close Window',
      accelerator: 'CommandOrControl+Shift+W',
      click: () => {
        getActiveWindow()?.close();
      },
    },
  ];
}

function editMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
    { type: 'separator' },
    {
      label: '自动换行',
      type: 'checkbox',
      checked: menuDeps.getWordWrap(),
      accelerator: 'Option+Z',
      click: (item) => {
        const enabled = !!item.checked;
        menuDeps.setWordWrap(enabled);
        sendMenuCommand({ type: 'toggleWordWrap', enabled });
      },
    },
  ];
}

function viewMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: '放大',
      accelerator: 'CommandOrControl+=',
      click: () => adjustZoom(ZOOM_STEP),
    },
    {
      label: '放大',
      accelerator: 'CommandOrControl+Plus',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => adjustZoom(ZOOM_STEP),
    },
    {
      label: '放大（小键盘）',
      accelerator: 'CommandOrControl+numadd',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: () => adjustZoom(ZOOM_STEP),
    },
    {
      label: '缩小',
      accelerator: 'CommandOrControl+-',
      click: () => adjustZoom(-ZOOM_STEP),
    },
    {
      label: '实际大小',
      accelerator: 'CommandOrControl+0',
      click: () => resetZoom(),
    },
    { type: 'separator' },
    { role: 'toggleDevTools' },
    { role: 'reload' },
  ];
}

function windowMenuTemplate(): MenuItemConstructorOptions[] {
  return [{ role: 'minimize' }, { role: 'close' }];
}

function buildAppMenu(): ElectronMenu {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    { label: '文件', submenu: fileMenuTemplate() },
    { label: '编辑', submenu: editMenuTemplate() },
    { label: '查看', submenu: viewMenuTemplate() },
    { label: '窗口', submenu: windowMenuTemplate() },
  ]);
}

function popupAppMenu(id: AppMenuId, win: ElectronBrowserWindow): void {
  const template =
    id === 'edit' ? editMenuTemplate() : id === 'view' ? viewMenuTemplate() : windowMenuTemplate();
  Menu.buildFromTemplate(template).popup({ window: win });
}

function createWindow(targetPath?: string, opts?: { blank?: boolean }): ElectronBrowserWindow {
  const icon = resolveAppIcon();
  const blank = opts?.blank ?? false;
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: targetPath
      ? `${targetPath
          .split(/[/\\\\]/)
          .filter(Boolean)
          .pop()} - Echoly`
      : 'Echoly',
    backgroundColor: '#1a1d23',
    titleBarStyle: 'hiddenInset',
    ...(icon ? { icon } : {}),
    // Windows：去掉原生菜单栏单独一行，菜单并入渲染进程顶栏
    autoHideMenuBar: process.platform === 'win32',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true, // 启用 <webview> 标签支持
    },
  });

  registerZoomShortcuts(win);
  trackWindow(win);

  // `blank` marks windows opened via File > New Window: they should start
  // with no workspace instead of inheriting the shared WorkspaceService's
  // currently-open project (see App.tsx `isBlankNewWindow`).
  // `targetPath` (if set) is passed as ?workspace= so that window can open it itself.
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (blank) url.searchParams.set('blank', '1');
    if (targetPath) url.searchParams.set('workspace', targetPath);
    win.loadURL(url.toString());
  } else {
    const query: Record<string, string> = {};
    if (blank) query.blank = '1';
    if (targetPath) query.workspace = targetPath;
    win.loadFile(
      join(__dirname, '../renderer/index.html'),
      Object.keys(query).length ? { query } : {},
    );
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async () => {
  const settings = new SettingsStore(app.getPath('userData'));
  menuDeps = {
    getAutoSave: () => settings.get().autoSave === true,
    setAutoSave: (enabled) => {
      settings.save({ autoSave: enabled });
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(buildAppMenu());
      }
    },
    getWordWrap: () => isWordWrapEnabled,
    setWordWrap: (enabled) => {
      isWordWrapEnabled = enabled;
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(buildAppMenu());
      }
    },
  };

  // 初始化扩展管理器（后台初始化，不阻塞 UI）
  setTimeout(async () => {
    try {
      const workspaceRoot = app.getPath('userData'); // 默认工作区
      await initializeExtensionManager({
        workspaceRoot,
        onMessage: (message) => {
          // 转发扩展消息到主窗口
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('extension:message', message);
          }
        },
      });
      console.log('Extension Manager initialized');
    } catch (err) {
      console.error('Failed to initialize Extension Manager:', err);
    }
  }, 2000); // 延迟2秒初始化，避免阻塞主窗口启动

  // macOS 使用系统菜单栏；Windows/Linux 去掉原生菜单行，由顶栏弹出
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(buildAppMenu());
  } else {
    Menu.setApplicationMenu(null);
  }

  const sessions = new SessionStore(app.getPath('userData'));
  const resolveSession = () => windowRegistry.resolve(getActiveWindow);
  const resolveWorkspace = () => resolveSession().workspace;
  const terminals = new TerminalService(
    () => getActiveWindow(),
    () => resolveWorkspace().getRoot() ?? process.cwd(),
  );
  const ssh = new SshSessionManager(resolveSession, app.getPath('userData'), () =>
    getActiveWindow(),
  );
  windowRegistry.setSessionDisposeHook((wcId) => ssh.disconnectWindow(wcId));
  terminals.setSshManager(ssh);
  terminals.setCwdResolver((rel) => resolveWorkspace().resolveAbsolute(rel ?? '.'));
  const git = new GitService(resolveWorkspace, () => getActiveWindow(), ssh);
  const search = new SearchService(resolveWorkspace);
  const agents = new AgentService({
    settings,
    registry: windowRegistry,
    getWindow: () => getActiveWindow(),
  });

  registerIpc({
    ipcMain,
    dialog,
    settings,
    sessions,
    registry: windowRegistry,
    agents,
    terminals,
    git,
    search,
    ssh,
    getWindow: () => getActiveWindow(),
    popupAppMenu,
    onSettingsChanged: () => {
      agents.onPermissionModeChanged(settings.get().permissionMode);
      if (process.platform === 'darwin') {
        Menu.setApplicationMenu(buildAppMenu());
      }
    },
  });

  initUpdater(() => settings.get().updateFeed ?? null);

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

export { createWindow };

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  // 清理扩展管理器
  await disposeExtensionManager();
});

export { randomUUID };
