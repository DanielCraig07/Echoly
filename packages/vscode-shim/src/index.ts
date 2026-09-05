/**
 * VSCode API Shim Layer
 * 模拟 VSCode Extension API，使 VSCode 扩展能够在 Electron 环境中运行
 * Updated: 2026-08-18 22:37
 */

import * as vscode from 'vscode';

/**
 * 受控扩展 API 白名单。
 *
 * vscode-shim 只为扩展提供白名单内的命名空间（授权范围内的功能）。访问未列入
 * 白名单的 API（如 debug/tasks/scm 等未实现能力）会记录警告并返回空 stub，避免
 * 无限适配 VSCode 全部 API 造成维护失控。新增可用能力时在此登记即可。
 */
export const VSCODE_API_WHITELIST = new Set([
  'commands',
  'window',
  'workspace',
  'Uri',
  'EventEmitter',
  'Disposable',
  'Range',
  'Position',
  'Selection',
  'Location',
  'Diagnostic',
  'DiagnosticSeverity',
  'MarkdownString',
  'ThemeIcon',
  'CodeAction',
  'CancellationTokenSource',
  'TreeItem',
  'TreeItemCollapsibleState',
  'languages',
  'extensions',
  'env',
  'StatusBarAlignment',
  'ViewColumn',
  'FileType',
  'version',
  'l10n',
  'ExtensionMode',
  'ExtensionKind',
]);

/** 扩展访问了未授权/未实现的 API，记录一条警告以便排查。 */
function warnUnsupportedApi(name: string): void {
  console.warn(`[vscode-shim] 扩展尝试访问未列入白名单的 API: "vscode.${name}"（已忽略）`);
}

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  workspaceState: any;
  globalState: any;
  extensionPath: string;
  storagePath?: string;
  globalStoragePath?: string;
  logPath?: string;
  extensionUri: vscode.Uri;
  environmentVariableCollection: any;
  extensionMode: vscode.ExtensionMode;
  secrets: any;
}

export interface VSCodeShimOptions {
  workspaceRoot: string;
  extensionPath: string;
  onCommand: (command: string, ...args: any[]) => Promise<any>;
  onMessage: (message: any) => void;
  onWebviewViewRegister?: (
    viewId: string,
    provider: any,
    extensionPath: string,
    options?: any,
  ) => void;
}

/**
 * VSCode API Shim 实现
 */
export class VSCodeShim {
  private commands = new Map<string, (...args: any[]) => any>();
  private disposables: vscode.Disposable[] = [];
  private workspaceRoot: string;
  private extensionPath: string;
  private onCommandHandler: (command: string, ...args: any[]) => Promise<any>;
  private onMessageHandler: (message: any) => void;
  private onWebviewViewRegisterHandler?: (
    viewId: string,
    provider: any,
    extensionPath: string,
    options?: any,
  ) => void;

  constructor(options: VSCodeShimOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.extensionPath = options.extensionPath;
    this.onCommandHandler = options.onCommand;
    this.onMessageHandler = options.onMessage;
    this.onWebviewViewRegisterHandler = options.onWebviewViewRegister;
  }

  /**
   * 创建 VSCode API 对象
   */
  createAPI(): typeof vscode {
    const self = this;

    return {
      // Commands API
      commands: {
        registerCommand(command: string, callback: (...args: any[]) => any) {
          self.commands.set(command, callback);
          return {
            dispose() {
              self.commands.delete(command);
            },
          };
        },
        executeCommand(command: string, ...args: any[]) {
          const handler = self.commands.get(command);
          if (handler) {
            return Promise.resolve(handler(...args));
          }
          return self.onCommandHandler(command, ...args);
        },
        getCommands() {
          return Promise.resolve(Array.from(self.commands.keys()));
        },
        registerTextEditorCommand() {
          return { dispose() {} };
        },
      },

      // Window API
      window: {
        showInformationMessage(message: string, ...items: any[]) {
          self.onMessageHandler({ type: 'info', message, items });
          return Promise.resolve(undefined);
        },
        showWarningMessage(message: string, ...items: any[]) {
          self.onMessageHandler({ type: 'warning', message, items });
          return Promise.resolve(undefined);
        },
        showErrorMessage(message: string, ...items: any[]) {
          self.onMessageHandler({ type: 'error', message, items });
          return Promise.resolve(undefined);
        },
        createOutputChannel(name: string, options?: any) {
          const logChannel = {
            append(value: string) {
              self.onMessageHandler({ type: 'output', channel: name, text: value });
            },
            appendLine(value: string) {
              self.onMessageHandler({ type: 'output', channel: name, text: value + '\n' });
            },
            clear() {},
            show() {},
            hide() {},
            dispose() {},
            name,
            replace() {},
            // LogOutputChannel methods
            trace(message: string, ...args: any[]) {
              console.log(`[${name}] TRACE:`, message, ...args);
            },
            debug(message: string, ...args: any[]) {
              console.log(`[${name}] DEBUG:`, message, ...args);
            },
            info(message: string, ...args: any[]) {
              console.log(`[${name}] INFO:`, message, ...args);
            },
            warn(message: string, ...args: any[]) {
              console.log(`[${name}] WARN:`, message, ...args);
            },
            error(message: string | Error, ...args: any[]) {
              console.error(`[${name}] ERROR:`, message, ...args);
            },
            logLevel: 1,
            onDidChangeLogLevel: () => ({ dispose() {} }),
          };
          return logChannel;
        },
        createWebviewPanel(viewType: string, title: string, showOptions: any, options?: any) {
          return {
            webview: {
              html: '',
              onDidReceiveMessage: () => ({ dispose() {} }),
              postMessage(message: any) {
                self.onMessageHandler({ type: 'webview', viewType, message });
                return Promise.resolve(true);
              },
              asWebviewUri(uri: vscode.Uri) {
                return uri;
              },
              options: {},
              cspSource: '',
            },
            viewType,
            title,
            options: options || {},
            onDidDispose: () => ({ dispose() {} }),
            onDidChangeViewState: () => ({ dispose() {} }),
            reveal() {},
            dispose() {},
            active: true,
            visible: true,
          } as any;
        },
        activeTextEditor: undefined,
        visibleTextEditors: [],
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
        onDidChangeTextEditorSelection: () => ({ dispose() {} }),
        onDidChangeTextEditorVisibleRanges: () => ({ dispose() {} }),
        onDidChangeTextEditorOptions: () => ({ dispose() {} }),
        onDidChangeTextEditorViewColumn: () => ({ dispose() {} }),
        tabGroups: {
          all: [],
          activeTabGroup: undefined,
          onDidChangeTabs: () => ({ dispose() {} }),
          onDidChangeTabGroups: () => ({ dispose() {} }),
          close(tab: any) {
            return Promise.resolve(true);
          },
        },
        state: {
          focused: true,
        },
        onDidChangeWindowState: () => ({ dispose() {} }),
        showTextDocument() {
          return Promise.resolve({} as any);
        },
        createTerminal() {
          return {} as any;
        },
        createStatusBarItem(alignment?: any, priority?: number) {
          return {
            text: '',
            tooltip: '',
            color: undefined,
            backgroundColor: undefined,
            command: undefined,
            alignment: alignment || 1,
            priority: priority || 0,
            show() {},
            hide() {},
            dispose() {},
          } as any;
        },
        registerTreeDataProvider() {
          return { dispose() {} };
        },
        registerWebviewViewProvider(viewId: string, provider: any, options?: any) {
          console.log(`Registered WebviewView provider: ${viewId}`);
          if (self.onWebviewViewRegisterHandler) {
            self.onWebviewViewRegisterHandler(viewId, provider, self.extensionPath, options);
          }
          return { dispose() {} };
        },
        registerWebviewPanelSerializer(viewType: string, serializer: any) {
          return { dispose() {} };
        },
        registerUriHandler(handler: any) {
          return { dispose() {} };
        },
        registerFileDecorationProvider(provider: any) {
          return { dispose() {} };
        },
        registerTerminalLinkProvider(provider: any) {
          return { dispose() {} };
        },
        registerTerminalProfileProvider(id: string, provider: any) {
          return { dispose() {} };
        },
        createTreeView() {
          return {} as any;
        },
        showQuickPick() {
          return Promise.resolve(undefined);
        },
        showInputBox(options?: any) {
          // 简化实现：返回空字符串表示用户取消
          // 实际使用中可以通过 IPC 调用主进程的 dialog
          console.log('showInputBox called:', options);
          return Promise.resolve(undefined);
        },
        withProgress() {
          return Promise.resolve(undefined as any);
        },
        setStatusBarMessage() {
          return { dispose() {} };
        },
        showWorkspaceFolderPick() {
          return Promise.resolve(undefined);
        },
        showOpenDialog() {
          return Promise.resolve(undefined);
        },
        showSaveDialog() {
          return Promise.resolve(undefined);
        },
        terminals: [],
        activeTerminal: undefined,
        onDidOpenTerminal: () => ({ dispose() {} }),
        onDidCloseTerminal: () => ({ dispose() {} }),
        onDidChangeActiveTerminal: () => ({ dispose() {} }),
        activeColorTheme: {} as any,
        onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      } as any,

      // Workspace API
      workspace: {
        workspaceFolders: this.workspaceRoot
          ? [
              {
                uri: { fsPath: this.workspaceRoot, scheme: 'file' } as vscode.Uri,
                name: this.workspaceRoot.split('/').pop() || 'workspace',
                index: 0,
              },
            ]
          : undefined,
        getConfiguration(section?: string) {
          return {
            get(key: string, defaultValue?: any) {
              return defaultValue;
            },
            has(key: string) {
              return false;
            },
            inspect(key: string) {
              return {
                key: section ? `${section}.${key}` : key,
                defaultValue: undefined,
                globalValue: undefined,
                workspaceValue: undefined,
                workspaceFolderValue: undefined,
                defaultLanguageValue: undefined,
                globalLanguageValue: undefined,
                workspaceLanguageValue: undefined,
                workspaceFolderLanguageValue: undefined,
                languageIds: undefined,
              };
            },
            update(key: string, value: any, configurationTarget?: any) {
              return Promise.resolve();
            },
          } as any;
        },
        onDidChangeConfiguration: () => ({ dispose() {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        textDocuments: [],
        onDidOpenTextDocument: () => ({ dispose() {} }),
        onDidCloseTextDocument: () => ({ dispose() {} }),
        onDidChangeTextDocument: () => ({ dispose() {} }),
        onWillSaveTextDocument: () => ({ dispose() {} }),
        onDidSaveTextDocument: () => ({ dispose() {} }),
        openTextDocument() {
          return Promise.resolve({} as any);
        },
        saveAll() {
          return Promise.resolve(true);
        },
        applyEdit() {
          return Promise.resolve(true);
        },
        createFileSystemWatcher() {
          return {
            onDidCreate: () => ({ dispose() {} }),
            onDidChange: () => ({ dispose() {} }),
            onDidDelete: () => ({ dispose() {} }),
            dispose() {},
          } as any;
        },
        findFiles() {
          return Promise.resolve([]);
        },
        name: undefined,
        rootPath: this.workspaceRoot,
        workspaceFile: undefined,
        updateWorkspaceFolders() {
          return true;
        },
        asRelativePath(pathOrUri: string | vscode.Uri) {
          return pathOrUri.toString();
        },
        getWorkspaceFolder() {
          return undefined;
        },
        fs: {} as any,
        onDidCreateFiles: () => ({ dispose() {} }),
        onDidDeleteFiles: () => ({ dispose() {} }),
        onDidRenameFiles: () => ({ dispose() {} }),
        onWillCreateFiles: () => ({ dispose() {} }),
        onWillDeleteFiles: () => ({ dispose() {} }),
        onWillRenameFiles: () => ({ dispose() {} }),
        registerTextDocumentContentProvider() {
          return { dispose() {} };
        },
        registerTaskProvider() {
          return { dispose() {} };
        },
        registerFileSystemProvider() {
          return { dispose() {} };
        },
        isTrusted: true,
        onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
      } as any,

      // Uri
      Uri: {
        parse(value: string) {
          return { fsPath: value, scheme: 'file', toString: () => value } as vscode.Uri;
        },
        file(path: string) {
          return { fsPath: path, scheme: 'file', toString: () => path } as vscode.Uri;
        },
        joinPath(uri: vscode.Uri, ...paths: string[]) {
          return uri;
        },
        from(components: any) {
          return {} as vscode.Uri;
        },
      } as any,

      // ExtensionMode enum
      ExtensionMode: {
        Production: 1,
        Development: 2,
        Test: 3,
      },

      // Extension kind enum
      ExtensionKind: {
        UI: 1,
        Workspace: 2,
      },

      // Other enums and types
      StatusBarAlignment: { Left: 1, Right: 2 },
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      ViewColumn: { One: 1, Two: 2, Three: 3, Active: -1, Beside: -2 },
      TextEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
      OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
      DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
      EndOfLine: { LF: 1, CRLF: 2 },
      FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },

      // Languages API (minimal)
      languages: {
        registerCompletionItemProvider() {
          return { dispose() {} };
        },
        registerHoverProvider() {
          return { dispose() {} };
        },
        registerCodeActionsProvider() {
          return { dispose() {} };
        },
        createDiagnosticCollection() {
          return {
            set() {},
            delete() {},
            clear() {},
            dispose() {},
            name: '',
            forEach() {},
            get() {
              return undefined;
            },
            has() {
              return false;
            },
          } as any;
        },
      } as any,

      // Environment
      env: {
        appName: 'Deepseek IDE',
        appRoot: this.extensionPath,
        language: 'zh-cn',
        clipboard: {
          readText() {
            return Promise.resolve('');
          },
          writeText() {
            return Promise.resolve();
          },
        },
        machineId: 'unknown-machine-id',
        sessionId: 'unknown-session-id',
        remoteName: '',
        shell: process.env.SHELL || '/bin/bash',
        uiKind: 1, // UIKind.Desktop
        openExternal() {
          return Promise.resolve(true);
        },
        asExternalUri(target: vscode.Uri) {
          return Promise.resolve(target);
        },
        uriScheme: 'vscode',
        logLevel: 1, // LogLevel.Info
        onDidChangeLogLevel: () => ({ dispose() {} }),
        isNewAppInstall: false,
        isTelemetryEnabled: false,
        onDidChangeTelemetryEnabled: () => ({ dispose() {} }),
        appHost: 'desktop',
      } as any,

      // Extensions (minimal)
      extensions: {
        getExtension(extensionId?: string) {
          // 始终返回一个有效对象，即使 extensionId 为空
          const id = extensionId || 'unknown.extension';
          const parts = id.split('.');
          return {
            id,
            extensionUri: {
              fsPath: self.extensionPath,
              scheme: 'file',
              toString: () => self.extensionPath,
            } as vscode.Uri,
            extensionPath: self.extensionPath,
            isActive: true,
            packageJSON: {
              name: parts[parts.length - 1] || 'extension',
              publisher: parts[0] || 'unknown',
              version: '1.0.0',
              displayName: id,
              description: '',
              engines: { vscode: '^1.94.0' },
              contributes: {},
              activationEvents: [],
            },
            exports: {},
            activate() {
              return Promise.resolve();
            },
            extensionKind: 1,
          };
        },
        all: [],
        onDidChange: () => ({ dispose() {} }),
      } as any,

      // Other exports (stubs)
      debug: {} as any,
      tasks: {} as any,
      scm: {} as any,
      comments: {} as any,
      authentication: {} as any,
      tests: {} as any,
      l10n: {
        t(message: string) {
          return message;
        },
        bundle: undefined,
        uri: undefined,
      } as any,

      // Notebook API
      notebooks: {
        createNotebookController() {
          return {
            dispose() {},
          };
        },
      } as any,

      NotebookCellOutputItem: {
        text(value: string, mime?: string) {
          return {
            mime: mime || 'text/plain',
            data: Buffer.from(value),
          };
        },
        json(value: any, mime?: string) {
          return {
            mime: mime || 'application/json',
            data: Buffer.from(JSON.stringify(value)),
          };
        },
        error(value: Error) {
          return {
            mime: 'application/vnd.code.notebook.error',
            data: Buffer.from(
              JSON.stringify({
                name: value.name,
                message: value.message,
                stack: value.stack,
              }),
            ),
          };
        },
        stdout(value: string) {
          return {
            mime: 'application/vnd.code.notebook.stdout',
            data: Buffer.from(value),
          };
        },
        stderr(value: string) {
          return {
            mime: 'application/vnd.code.notebook.stderr',
            data: Buffer.from(value),
          };
        },
      } as any,

      // EventEmitter
      EventEmitter: class EventEmitter {
        private _listeners: any[] = [];
        get event() {
          return (listener: any) => {
            this._listeners.push(listener);
            return { dispose: () => {} };
          };
        }
        fire(data: any) {
          this._listeners.forEach((l) => l(data));
        }
        dispose() {
          this._listeners = [];
        }
      } as any,

      // Classes and constructors
      Disposable: class Disposable {
        constructor(private callOnDispose: () => void) {}
        dispose() {
          if (this.callOnDispose) {
            this.callOnDispose();
          }
        }
        static from(...disposables: { dispose(): any }[]) {
          return new Disposable(() => {
            disposables.forEach((d) => {
              if (d && typeof d.dispose === 'function') {
                d.dispose();
              }
            });
          });
        }
      } as any,
      Range: class Range {} as any,
      Position: class Position {} as any,
      Selection: class Selection {} as any,
      Location: class Location {} as any,
      Diagnostic: class Diagnostic {} as any,
      DiagnosticRelatedInformation: class DiagnosticRelatedInformation {} as any,
      WorkspaceEdit: class WorkspaceEdit {} as any,
      CompletionItem: class CompletionItem {} as any,
      CodeLens: class CodeLens {} as any,
      Hover: class Hover {} as any,
      MarkdownString: class MarkdownString {
        value = '';
        constructor(value?: string) {
          if (value) this.value = value;
        }
      } as any,
      ThemeColor: class ThemeColor {} as any,
      ThemeIcon: class ThemeIcon {} as any,
      CodeAction: class CodeAction {} as any,
      CodeActionKind: {
        QuickFix: 'quickfix',
        Refactor: 'refactor',
        RefactorExtract: 'refactor.extract',
        RefactorInline: 'refactor.inline',
        RefactorRewrite: 'refactor.rewrite',
        Source: 'source',
        SourceOrganizeImports: 'source.organizeImports',
        SourceFixAll: 'source.fixAll',
        Empty: '',
      } as any,
      SnippetString: class SnippetString {} as any,
      CancellationTokenSource: class CancellationTokenSource {
        token = {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        };
        cancel() {}
        dispose() {}
      } as any,
      TreeItem: class TreeItem {} as any,
      TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },

      // VSCode version
      version: '1.94.0',

      // 受控白名单：为未授权命名空间注入 getter，访问时告警并返回空 stub
      ...Object.fromEntries(
        ['debug', 'tasks', 'scm', 'comments', 'authentication', 'tests', 'notebooks'].map(
          (name) => [
            name,
            new Proxy({} as any, {
              get(_t, prop: string) {
                warnUnsupportedApi(`${name}.${String(prop)}`);
                return undefined;
              },
            }),
          ],
        ),
      ),
    } as any;
  }

  /**
   * 执行命令
   */
  async executeCommand(command: string, ...args: any[]) {
    const handler = this.commands.get(command);
    if (handler) {
      return handler(...args);
    }
    return this.onCommandHandler(command, ...args);
  }

  /**
   * 清理资源
   */
  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.commands.clear();
  }
}

/**
 * 创建扩展上下文
 */
export function createExtensionContext(extensionPath: string): ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {
      get(key: string, defaultValue?: any) {
        return defaultValue;
      },
      update(key: string, value: any) {
        return Promise.resolve();
      },
      keys() {
        return [];
      },
    },
    globalState: {
      get(key: string, defaultValue?: any) {
        return defaultValue;
      },
      update(key: string, value: any) {
        return Promise.resolve();
      },
      keys() {
        return [];
      },
      setKeysForSync() {},
    },
    extensionPath,
    extensionUri: {
      fsPath: extensionPath,
      scheme: 'file',
      toString: () => extensionPath,
    } as vscode.Uri,
    asAbsolutePath(relativePath: string) {
      return require('path').join(extensionPath, relativePath);
    },
    storageUri: { fsPath: extensionPath, scheme: 'file' } as vscode.Uri,
    globalStorageUri: { fsPath: extensionPath, scheme: 'file' } as vscode.Uri,
    logUri: { fsPath: extensionPath, scheme: 'file' } as vscode.Uri,
    environmentVariableCollection: {
      persistent: true,
      replace() {},
      append() {},
      prepend() {},
      get() {
        return undefined;
      },
      forEach() {},
      delete() {},
      clear() {},
    },
    extensionMode: 1, // Production
    secrets: {
      get(key: string) {
        return Promise.resolve(undefined);
      },
      store(key: string, value: string) {
        return Promise.resolve();
      },
      delete(key: string) {
        return Promise.resolve();
      },
      onDidChange: () => ({ dispose() {} }),
    },
    extension: {
      id: 'unknown.extension',
      extensionUri: {
        fsPath: extensionPath,
        scheme: 'file',
        toString: () => extensionPath,
      } as vscode.Uri,
      extensionPath,
      isActive: true,
      packageJSON: {
        name: 'extension',
        publisher: 'unknown',
        version: '1.0.0',
        displayName: 'Extension',
        description: '',
        engines: { vscode: '^1.94.0' },
      },
      exports: undefined,
      extensionKind: 1,
    },
    languageModelAccessInformation: {
      onDidChange: () => ({ dispose() {} }),
      canSendRequest: () => undefined,
    },
  } as ExtensionContext;
}
