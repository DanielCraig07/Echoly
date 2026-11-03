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
  'RelativePattern',
  'LanguageStatusSeverity',
]);

/** 扩展访问了未授权/未实现的 API，记录一条警告以便排查。 */
/**
 * `vscode.CodeActionKind`：一个带值的类，不是一组字符串。
 *
 * 官方语义里 `Refactor.append('extract')` 这种「父种类 + 子段」是常态用法，
 * 所以必须是对象。`contains` 按官方的定义走：`'source.fixAll'.contains('source')`
 * 为真（父种类包含子种类），`intersects` 有公共前缀也算相交。
 */
class CodeActionKindImpl {
  static readonly Empty = new CodeActionKindImpl('');
  static readonly QuickFix = new CodeActionKindImpl('quickfix');
  static readonly Refactor = new CodeActionKindImpl('refactor');
  static readonly RefactorExtract = new CodeActionKindImpl('refactor.extract');
  static readonly RefactorInline = new CodeActionKindImpl('refactor.inline');
  static readonly RefactorRewrite = new CodeActionKindImpl('refactor.rewrite');
  static readonly Source = new CodeActionKindImpl('source');
  static readonly SourceOrganizeImports = new CodeActionKindImpl('source.organizeImports');
  static readonly SourceFixAll = new CodeActionKindImpl('source.fixAll');
  static readonly Notebook = new CodeActionKindImpl('notebook');

  constructor(public readonly value: string) {}

  /** 拼一个子种类：`Refactor.append('extract')` → `refactor.extract`。 */
  append(part: string): CodeActionKindImpl {
    return new CodeActionKindImpl(this.value ? `${this.value}.${part}` : part);
  }

  /** 本种类是否包含 other（父包含子）。 */
  contains(other: CodeActionKindImpl): boolean {
    if (other.value === this.value) return true;
    return other.value.startsWith(`${this.value}.`);
  }

  /** 两者是否有公共前缀（`a.b` 与 `a.b.c` 相交）。 */
  intersects(other: CodeActionKindImpl): boolean {
    return this.contains(other) || other.contains(this);
  }

  toString(): string {
    return this.value;
  }
}

/**
 * 把 glob 入参印成人看得懂的一小段（出于排查用，不参与任何逻辑）。
 *
 * `RelativePattern` 与纯字符串两种形态都要能读出来 —— 排查「为什么扩展的
 * watcher 不生效」时，日志里得能看出它到底在等什么。
 */
function describeGlobPattern(pattern: unknown): string {
  if (typeof pattern === 'string') return JSON.stringify(pattern);
  if (pattern && typeof pattern === 'object') {
    const record = pattern as { base?: unknown; baseUri?: unknown; pattern?: unknown };
    const base =
      (record.baseUri as any)?.fsPath ?? record.base ?? (record as any).toString?.() ?? '?';
    return `RelativePattern(${base} / ${String(record.pattern ?? '?')})`;
  }
  return String(pattern);
}

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
    /** 注册它的扩展 id。禁用/卸载时要按它把这些视图一起摘掉 */
    extensionId?: string,
  ) => void;
}

/**
 * VSCode API Shim 实现
 */
export class VSCodeShim {
  private commands = new Map<string, (...args: any[]) => any>();
  /**
   * 命令 → 注册它的扩展 id。
   *
   * 为什么需要：命令面板要能列出「这个扩展贡献了哪些命令」，禁用/卸载时还要把它们
   * 一起摘掉 —— 否则一个被禁用的扩展的命令还留在面板里，点下去毫无反应。
   */
  private commandOwners = new Map<string, string>();
  /** 视图 id → 注册它的扩展 id（同上）。 */
  private viewOwners = new Map<string, string>();
  /**
   * 当前正在 activate 的扩展 id。
   *
   * 扩展在 activate() 里注册命令/视图时不会自报家门，只能在调用它之前把「现在是谁」
   * 记下来，注册时顺手记到归属表里。由 ExtensionHost 在 activate 前后设置与清空。
   */
  activeExtensionId?: string;
  /**
   * 自定义编辑器提供者，按 viewType 收着。
   *
   * 收下来是为了让注册本身有意义（扩展据此认为自己可用，激活不失败）；
   * 「打开 .xxx 文件时交给它渲染」是另一件事，本实现不做 —— 见 VERIFY.md 已知边界。
   */
  private customEditorProviders = new Map<string, { provider: any; options?: any }>();
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
    extensionId?: string,
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
          if (self.activeExtensionId) self.commandOwners.set(command, self.activeExtensionId);
          return {
            dispose() {
              self.commands.delete(command);
              self.commandOwners.delete(command);
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
          if (self.activeExtensionId) self.viewOwners.set(viewId, self.activeExtensionId);
          if (self.onWebviewViewRegisterHandler) {
            self.onWebviewViewRegisterHandler(
              viewId,
              provider,
              self.extensionPath,
              options,
              self.activeExtensionId,
            );
          }
          return {
            dispose() {
              self.viewOwners.delete(viewId);
            },
          };
        },
        registerWebviewPanelSerializer(viewType: string, serializer: any) {
          return { dispose() {} };
        },
        /**
         * 自定义编辑器（`CustomTextEditorProvider` / `CustomEditorProvider`）。
         *
         * 实测有真实扩展在 activate() 里**第一件事**就调它 —— `es6kr.claude-sessions`
         * （Claude Code Sessions）就是：缺这个方法时整个扩展激活失败，
         * 界面上显示「已安装，但激活失败：…is not a function」。
         * 注册本身是有意义的（扩展据此认为自己可用），所以这里收下并返回一个
         * 真的 Disposable；至于「打开 .xxx 文件时用这个编辑器渲染」——
         * 那是另一件事，本实现不做（见 VERIFY.md 的已知边界）。
         */
        registerCustomEditorProvider(viewType: string, provider: any, options?: any) {
          console.log(`Registered custom editor provider: ${viewType}`);
          self.customEditorProviders.set(viewType, { provider, options });
          return {
            dispose() {
              self.customEditorProviders.delete(viewType);
            },
          };
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
        /**
         * 文件监视器。**不监听任何东西**（没有实现真实的 fs watch），
         * 但形状要齐：扩展拿到之后会挂 onDidCreate/Change/Delete，缺一个就是
         * 激活后的异步 TypeError。入参（glob 或 RelativePattern）明确丢弃 ——
         * 与其假装匹配，不如什么都不报。
         */
        createFileSystemWatcher(globPattern?: any, ignoreCreateEvents?: boolean) {
          console.log(
            `[vscode-shim] createFileSystemWatcher(${describeGlobPattern(globPattern)}) —— 本实现不监听文件变化`,
          );
          return {
            ignoreCreateEvents: ignoreCreateEvents === true,
            ignoreChangeEvents: false,
            ignoreDeleteEvents: false,
            onDidCreate: () => ({ dispose() {} }),
            onDidChange: () => ({ dispose() {} }),
            onDidDelete: () => ({ dispose() {} }),
            dispose() {},
          } as any;
        },
        /**
         * 文件查找。返回空数组是**刻意的**：本实现没有索引/glob 引擎，
         * 返回「看起来像结果」的东西会让扩展基于假结果做决定。
         * 入参接受 RelativePattern（官方签名允许），只是不参与计算。
         */
        findFiles(include?: any, exclude?: any, maxResults?: number, token?: any) {
          console.log(
            `[vscode-shim] findFiles(${describeGlobPattern(include)}) —— 本实现不返回文件`,
          );
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
      /**
       * `vscode.RelativePattern`。
       *
       * 实测 `vishalguptax.claude-manager@2.21.0` 在 activate() 里
       * `new vscode.RelativePattern(folder, glob)` —— 没有这个类时整个扩展激活失败
       * （`it.RelativePattern is not a constructor`）。
       *
       * 形状对齐官方：`base`（字符串，已废弃但扩展还在读）与 `baseUri` 都给，
       * `pattern` 原样保留。**它本身不做任何文件匹配** —— 匹配是 findFiles /
       * createFileSystemWatcher 的事，那两个在 shim 里本来就没有真实现。
       */
      RelativePattern: class RelativePattern {
        base: string;
        baseUri: vscode.Uri;
        pattern: string;
        constructor(base: any, pattern: string) {
          // base 三种合法形态：工作区文件夹、Uri、纯路径字符串
          const uri: vscode.Uri =
            typeof base === 'string'
              ? ({ fsPath: base, scheme: 'file', toString: () => base } as vscode.Uri)
              : base && base.uri
                ? base.uri
                : (base as vscode.Uri);
          this.baseUri = uri;
          this.base = (uri as any)?.fsPath ?? String(uri);
          this.pattern = pattern;
        }
      } as any,

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
      /**
       * 语言状态项的严重级别。
       *
       * 实测 `esbenp.prettier-vscode@12` 在 activate() 里就取这个导出（它给
       * 「Prettier 是否可用」挂一个语言状态项），缺了整个扩展激活失败。
       * 取值对齐官方（Information=0 / Warning=1 / Error=2）。
       */
      LanguageStatusSeverity: { Information: 0, Warning: 1, Error: 2 },
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
        /**
         * 语言状态项（编辑器右下角那一条状态）。收下并返回一个形状完整的对象：
         * 扩展会去改 `severity` / `text` / `busy` 这些字段，字段缺失会让它在
         * 后续赋值时抛错 —— 而那是异步的，报出来就不在 activate 的栈里了。
         * 本实现不把它画到界面上（没有对应的 UI），见 VERIFY.md 已知边界。
         */
        createLanguageStatusItem(id: string, selector: any) {
          return {
            id,
            selector,
            name: undefined,
            severity: 0,
            text: '',
            detail: undefined,
            busy: false,
            command: undefined,
            accessibilityInformation: undefined,
            dispose() {},
          } as any;
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
      /**
       * 代码动作种类。
       *
       * 原来只是一堆**字符串常量**，于是 `CodeActionKind.SourceFixAll.append('x')`
       * 直接崩 —— 而这是扩展在**模块顶层**就会算的东西：实测
       * `esbenp.prettier-vscode@12` 因此在主模块加载阶段就失败
       * （`CodeActionKind.SourceFixAll.append is not a function`），
       * 连 activate 都到不了。官方这里是个带 `append/contains/intersects` 的类。
       */
      CodeActionKind: CodeActionKindImpl,
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
  /** 所有由扩展注册的命令（带归属）。命令面板据此列出「扩展命令」。 */
  listCommands(): { command: string; extensionId?: string }[] {
    return Array.from(this.commands.keys()).map((command) => ({
      command,
      extensionId: this.commandOwners.get(command),
    }));
  }

  /** 某个扩展注册了哪些视图 id。 */
  listWebviewViewIds(extensionId: string): string[] {
    return Array.from(this.viewOwners.entries())
      .filter(([, owner]) => owner === extensionId)
      .map(([viewId]) => viewId);
  }

  /**
   * 摘掉一个扩展的全部注册（命令 + 视图）。禁用与卸载都要走这一步。
   *
   * 返回被摘掉的 viewId 列表：manager 那边另有一份 provider 映射要一起清，
   * 这里只负责 shim 自己的两本账。
   */
  dropExtensionRegistrations(extensionId: string): string[] {
    for (const [command, owner] of Array.from(this.commandOwners.entries())) {
      if (owner === extensionId) {
        this.commands.delete(command);
        this.commandOwners.delete(command);
      }
    }
    const droppedViews: string[] = [];
    for (const [viewId, owner] of Array.from(this.viewOwners.entries())) {
      if (owner === extensionId) {
        droppedViews.push(viewId);
        this.viewOwners.delete(viewId);
      }
    }
    return droppedViews;
  }

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
    this.commandOwners.clear();
    this.viewOwners.clear();
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

export {
  DEFAULT_OPEN_VSX_REGISTRY,
  MAX_MARKETPLACE_PAGE_SIZE,
  buildDownloadUrl,
  buildSearchUrl,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxSearch,
} from './openVsx';
export type { MarketplaceExtension } from './openVsx';
