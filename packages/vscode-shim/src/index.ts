/**
 * VSCode API Shim Layer
 * 模拟 VSCode Extension API，使 VSCode 扩展能够在 Electron 环境中运行
 * Updated: 2026-08-18 22:37
 */

import * as vscode from 'vscode';
import { ShimUri } from './uri';
import { getRegisteredExtension, listRegisteredExtensionIds } from './extensionRegistry';

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
  'UIKind',
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

/**
 * 从扩展给的「Uri」里取磁盘路径。
 *
 * `workspace.fs` 的方法收的都是 `vscode.Uri`，但实测有扩展图省事直接传字符串。
 * 两种都收下：判断错一个就是「读不到文件」，而报错位置离这里很远。
 */
function fsPathOfUri(uri: any): string {
  if (typeof uri === 'string') return uri;
  return uri?.fsPath ?? uri?.path ?? String(uri);
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

/**
 * `vscode.Position` / `Range` / `Selection`。
 *
 * 以前这三个是**空类**（`class Range {}`），扩展 `new` 出来的是一个没有任何字段的
 * 对象。只读场景能糊过去，一旦要把「改哪儿」说清楚就露馅 —— Office Viewer 保存
 * markdown 时会 `edit.replace(uri, new Range(0, 0, lineCount, 0), text)`，
 * 空类拿到的范围谁也解释不了。
 *
 * 这里按 VS Code 的语义实现最小可用集：位置、区间、包含判断、四种构造形式。
 * 不追求把 `with` / `translate` 的每个重载都做全 —— 用到的都实现了，没用到的
 * 也不假装。
 */
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}

  isEqual(other: Position): boolean {
    return !!other && this.line === other.line && this.character === other.character;
  }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }

  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }

  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }

  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }

  compareTo(other: Position): number {
    if (this.line !== other.line) return this.line < other.line ? -1 : 1;
    if (this.character !== other.character) return this.character < other.character ? -1 : 1;
    return 0;
  }

  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta);
  }

  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;

  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number' && typeof b === 'number') {
      // (startLine, startCharacter, endLine, endCharacter)
      this.start = new Position(a, b);
      this.end = new Position(c ?? a, d ?? b);
    } else {
      this.start = a as Position;
      this.end = b as Position;
    }
    // VS Code 保证 start <= end，扩展（和我们的 applyEdit）都依赖这一点
    if (this.end.compareTo(this.start) < 0) {
      const swap = this.start;
      this.start = this.end;
      this.end = swap;
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }

  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }

  contains(positionOrRange: Position | Range): boolean {
    const target = positionOrRange as Position;
    if (typeof (positionOrRange as Range).start !== 'undefined') {
      const range = positionOrRange as Range;
      return this.contains(range.start) && this.contains(range.end);
    }
    return !target.isBefore(this.start) && !target.isAfter(this.end);
  }

  with(start?: Position, end?: Position): Range {
    return new Range(start ?? this.start, end ?? this.end);
  }
}

/** 选区。锚点与活动端可以反向，`start`/`end` 保持有序 —— 与 VS Code 一致。 */
export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;

  constructor(anchor: Position, active: Position);
  constructor(
    anchorLine: number,
    anchorCharacter: number,
    activeLine: number,
    activeCharacter: number,
  );
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const anchor = typeof a === 'number' ? new Position(a, b as number) : a;
    const active =
      typeof a === 'number' ? new Position(c ?? a, d ?? (b as number)) : (b as Position);
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

/** `WorkspaceEdit` 收下的条目（与 VS Code 一样的语义，只是我们自己解释）。 */
export interface WorkspaceEditDescriptor {
  textEdits: {
    fsPath: string;
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    newText: string;
  }[];
  fileOps: {
    kind: 'create' | 'delete' | 'rename';
    fsPath: string;
    newPath?: string;
    overwrite?: boolean;
  }[];
}

/**
 * `vscode.WorkspaceEdit` —— 只收集，不自己落盘。
 *
 * 落盘交给宿主（扩展宿主跑在主进程里，写文件、再通知渲染层刷新缓冲区都是它的事），
 * 所以这里只把扩展的意图翻译成一份**可执行的描述**。
 */
export class WorkspaceEdit {
  private entries: WorkspaceEditDescriptor['textEdits'] = [];
  private ops: WorkspaceEditDescriptor['fileOps'] = [];

  private static fsPathOf(uri: any): string {
    return typeof uri === 'string' ? uri : (uri?.fsPath ?? String(uri));
  }

  replace(uri: any, range: Range, newText: string): void {
    if (!range) throw new Error('[vscode-shim] WorkspaceEdit.replace 需要 range');
    this.entries.push({
      fsPath: WorkspaceEdit.fsPathOf(uri),
      startLine: range.start.line,
      startCharacter: range.start.character,
      endLine: range.end.line,
      endCharacter: range.end.character,
      newText: newText ?? '',
    });
  }

  insert(uri: any, position: Position, newText: string): void {
    if (!position) throw new Error('[vscode-shim] WorkspaceEdit.insert 需要 position');
    this.replace(uri, new Range(position, position), newText);
  }

  delete(uri: any, range: Range): void {
    this.replace(uri, range, '');
  }

  createFile(uri: any, options?: { overwrite?: boolean; ignoreIfExists?: boolean }): void {
    this.ops.push({
      kind: 'create',
      fsPath: WorkspaceEdit.fsPathOf(uri),
      overwrite: options?.overwrite === true,
    });
  }

  deleteFile(uri: any, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this.ops.push({ kind: 'delete', fsPath: WorkspaceEdit.fsPathOf(uri) });
  }

  renameFile(oldUri: any, newUri: any, options?: { overwrite?: boolean }): void {
    this.ops.push({
      kind: 'rename',
      fsPath: WorkspaceEdit.fsPathOf(oldUri),
      newPath: WorkspaceEdit.fsPathOf(newUri),
      overwrite: options?.overwrite === true,
    });
  }

  /** 有没有实际内容。宿主据此可以直接返回 true，省一次落盘。 */
  get size(): number {
    return this.entries.length + this.ops.length;
  }

  /** 交给宿主的描述。 */
  describe(): WorkspaceEditDescriptor {
    return { textEdits: [...this.entries], fileOps: [...this.ops] };
  }
}

/**
 * `vscode.languages` 命名空间。
 *
 * 为什么要给**整个**命名空间兜底：以前这里只有几个 `register*`，其余成员是
 * `undefined`，于是扩展在**主模块加载阶段**（不是 activate 里、没有 try/catch 可躲）
 * 调到一个没实现的方法就整个扩展起不来。实测 `cweijan.vscode-office`（Office Viewer）
 * 就是这么挂的：`languages.setLanguageConfiguration is not a function` ——
 * 用户看到的是「装上了但完全没用」，而真正的原因只是一行 API 缺失。
 *
 * 三条原则：
 * 1. **已知的成员照实现**（`getLanguages` 返回数组、语言状态项返回形状完整的对象）；
 * 2. **注册类一律收下并返回真的 Disposable**：扩展会往 `context.subscriptions` 里塞，
 *    返回 undefined 会在 dispose 时炸；
 * 3. **没实现的成员返回一个会打日志的 stub 函数**，而不是 undefined。方法形状对了，
 *    扩展就能继续往下走；日志保证我们不会把「其实没生效」当成「正常工作」。
 *    事件访问器（`onDidChangeDiagnostics` 之类）在 VS Code 里本身就是函数，形状正好一致。
 */
function makeLanguagesNamespace(): any {
  const register =
    (name: string) =>
    (..._args: any[]) => {
      console.log(
        `[vscode-shim] languages.${name}() —— 本实现不驱动这个 provider（它的效果不会出现在界面上）`,
      );
      return { dispose() {} };
    };

  const known: Record<string, any> = {
    registerCompletionItemProvider: register('registerCompletionItemProvider'),
    registerHoverProvider: register('registerHoverProvider'),
    registerCodeActionsProvider: register('registerCodeActionsProvider'),

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
    /**
     * 语言配置（括号配对、注释符号…）。我们没有真实的语言服务去消费它，
     * 但**必须收下**：Office Viewer 在主模块加载期就调它，缺了就是整个扩展挂掉。
     */
    setLanguageConfiguration(language: string, _configuration: unknown) {
      console.log(
        `[vscode-shim] languages.setLanguageConfiguration(${language}) —— 已收下（不驱动）`,
      );
      return { dispose() {} };
    },
    /** 已注册的语言。返回空数组而不是 undefined：扩展普遍会对它 `.map`。 */
    getLanguages() {
      return [] as any[];
    },
    getDiagnostics() {
      return [] as any[];
    },
    /**
     * 选择器匹配打分。VS Code 用它判断「这个 provider 管不管这份文档」。
     * 不做精确打分，只按 languageId 相等给一个正数；不相等返回 0。
     */
    match(selector: any, document: any): number {
      const languageId = document?.languageId;
      const list = Array.isArray(selector) ? selector : [selector];
      for (const item of list) {
        if (typeof item === 'string') {
          if (item === languageId || item === '*') return 10;
        } else if (item && typeof item === 'object') {
          if (item.language && item.language !== languageId) continue;
          if (item.scheme && item.scheme !== (document?.uri?.scheme ?? 'file')) continue;
          return 10;
        }
      }
      return 0;
    },
  };

  // 兜底：没实现的一律给 stub 函数（见上面第 3 条）。只对**读**生效。
  return new Proxy(known, {
    get(target, prop: string | symbol) {
      if (prop in target) return (target as any)[prop];
      if (typeof prop !== 'string') return undefined;
      const stub = (..._args: any[]) => {
        console.log(`[vscode-shim] languages.${prop}() —— 未实现，已返回空 stub（本次调用无效果）`);
        return { dispose() {} };
      };
      target[prop] = stub;
      return stub;
    },
  });
}

/**
 * 宿主（Echoly 主进程）为实现一个扩展的 `WebviewPanel` 提供的能力。
 *
 * 为什么要把这一整块交给宿主：面板的 HTML 要按我们自己的协议端出去、消息要在
 * 「扩展 ↔ 界面」之间来回，这两件事都只有宿主知道怎么办（协议名、渲染层的通道）。
 * shim 自己不去拼这些 —— 它还要能在纯 Node 里跑。
 */
export interface WebviewPanelBackend {
  /** 宿主分配的稳定 id；渲染层用它开标签、拼资源地址。 */
  panelId: string;
  /** 扩展设了 `webview.html`。宿主负责注入运行时/主题，并把标签开出来。 */
  setHtml(html: string): void;
  /** `webview.asWebviewUri(uri)`。 */
  asWebviewUri(uri: any): string;
  /** `webview.postMessage(message)`：扩展 → 界面。 */
  postMessage(message: any): Promise<boolean> | boolean | void;
  /** 拼进扩展页面 CSP 的源。 */
  readonly cspSource: string;
  /** 用户切到这个面板的标签时调（`panel.reveal()`）。 */
  reveal(): void;
  /** 面板被关掉时清理宿主这边的东西。 */
  dispose(): void;
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
  /**
   * 落盘 `WorkspaceEdit`。
   *
   * 扩展宿主跑在主进程里，写文件 + 通知渲染层刷新缓冲区都是它的事，shim 只负责
   * 把扩展的意图翻译成描述（见 WorkspaceEdit）。
   * **没给这个回调时 applyEdit 返回 false**，而不是假装成功 —— 谎报成功会让扩展
   * 以为改动已经落盘，用户那边其实什么都没发生。
   */
  onApplyEdit?: (edit: WorkspaceEditDescriptor) => Promise<boolean>;
  /**
   * 系统剪贴板。
   *
   * 由宿主注入（主进程里是 electron 的 clipboard）而不是 shim 自己去 require ——
   * shim 还要能在纯 Node 里跑（`npm run verify:extension`），那里没有 electron。
   */
  clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
  /**
   * 扩展要弹提示（`window.show{Information,Warning,Error}Message`）。
   *
   * 以前这三个只往 `onMessage` 丢一条消息，而**渲染层根本没人听** —— 于是扩展说
   * 「保存失败」「没有权限」全都石沉大海，用户看到的只是「按钮点了没反应」。
   * 宿主现在把它变成一条 toast。
   */
  onNotify?: (level: 'info' | 'warning' | 'error', message: string) => void;
  /**
   * 系统对话框（打开 / 保存 / 选择）。
   *
   * Office Viewer 的「插入图片」「导出 PDF」全走这三个。以前一律返回 undefined
   * （等于用户点了取消），按钮点下去毫无反应 —— 看起来就像插件坏了。
   * 返回 undefined 仍然表示「用户取消」，那是正常语义，不是失败。
   */
  onOpenDialog?: (options: any) => Promise<string[] | undefined>;
  onSaveDialog?: (options: any) => Promise<string | undefined>;
  onQuickPick?: (items: any[], options?: any) => Promise<any>;
  /** 让用户输入一行文本（系统没有这种对话框，没实现时等于「取消」）。 */
  onInputBox?: (options: any) => Promise<string | undefined>;
  /** 用系统浏览器打开链接（`env.openExternal`）。以前返回 true 但什么都没做。 */
  onOpenExternal?: (url: string) => Promise<boolean>;
  /**
   * 扩展调 `window.createWebviewPanel(...)`。
   *
   * 以前这一整个 API 是个**空壳**：返回一个 html setter 什么都不做的假面板。
   * Claude Code 的「+」（新会话）走的正是它 —— 于是点下去什么都不会发生，
   * 会话却被扩展记成「已经在面板里打开了」，侧栏跟着被清空。
   * 现在宿主真的把它变成一个编辑器标签（返回 backend 由宿主实现）。
   *
   * 没给这个回调时退回原来的空壳行为：面板不会出现，但扩展的代码不会因此炸。
   */
  onWebviewPanel?: (spec: {
    viewType: string;
    title: string;
    options?: any;
    /** 创建时正在 activate 的扩展 id（可能为空，例如命令是异步触发的）。 */
    extensionId?: string;
  }) => WebviewPanelBackend;
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
   * 当前正在 activate 的扩展的**磁盘目录**。
   *
   * 与 activeExtensionId 同时设置。为什么不能继续用 `this.extensionPath`：
   * 它被构造成工作区根目录（ExtensionHost 那边传的是 workspaceRoot），
   * 而注册 webview 视图时真正需要的是扩展自己的目录 —— 视图的资源、消息归属
   * 都挂在那个目录上。传错的后果是界面的资源地址全错（以前只能靠 `-/abs/` 兜底）。
   */
  activeExtensionPath?: string;
  /**
   * 自定义编辑器提供者，按 viewType 收着。
   *
   * 收下来是为了让注册本身有意义（扩展据此认为自己可用，激活不失败）；
   * 「打开 .xxx 文件时交给它渲染」是另一件事，本实现不做 —— 见 VERIFY.md 已知边界。
   */
  private disposables: vscode.Disposable[] = [];
  private workspaceRoot: string;
  private extensionPath: string;
  private onCommandHandler: (command: string, ...args: any[]) => Promise<any>;
  private onMessageHandler: (message: any) => void;
  /** 自定义编辑器：viewType → provider（以及它属于哪个扩展）。 */
  private customEditorProviders = new Map<
    string,
    { provider: any; options?: any; extensionId?: string }
  >();
  private onApplyEditHandler?: (edit: WorkspaceEditDescriptor) => Promise<boolean>;
  private clipboardHandler?: {
    readText(): Promise<string>;
    writeText(text: string): Promise<void>;
  };
  private notifyHandler?: (level: 'info' | 'warning' | 'error', message: string) => void;
  private openDialogHandler?: (options: any) => Promise<string[] | undefined>;
  private saveDialogHandler?: (options: any) => Promise<string | undefined>;
  private quickPickHandler?: (items: any[], options?: any) => Promise<any>;
  private inputBoxHandler?: (options: any) => Promise<string | undefined>;
  private openExternalHandler?: (url: string) => Promise<boolean>;
  private onWebviewViewRegisterHandler?: (
    viewId: string,
    provider: any,
    extensionPath: string,
    options?: any,
    extensionId?: string,
  ) => void;
  private onWebviewPanelHandler?: VSCodeShimOptions['onWebviewPanel'];
  /**
   * 已经开出去的 webview 面板，按宿主给的 panelId 存着。
   *
   * 存它是为了两个方向的消息：
   * - 界面 → 扩展：宿主收到访客页面的消息后调 `deliverPanelMessage` 投到这里的回调；
   * - 关标签 → 扩展：`disposePanel` 触发 `panel.onDidDispose`，扩展据此清掉
   *   「这个会话在面板里」的记录。
   */
  private webviewPanels = new Map<
    string,
    {
      messageHandlers: Set<(message: any) => void>;
      disposeCallbacks: Set<() => void>;
      backend: WebviewPanelBackend;
      disposed: boolean;
    }
  >();

  constructor(options: VSCodeShimOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.extensionPath = options.extensionPath;
    this.onCommandHandler = options.onCommand;
    this.onMessageHandler = options.onMessage;
    this.onWebviewViewRegisterHandler = options.onWebviewViewRegister;
    this.onApplyEditHandler = options.onApplyEdit;
    this.clipboardHandler = options.clipboard;
    this.notifyHandler = options.onNotify;
    this.openDialogHandler = options.onOpenDialog;
    this.saveDialogHandler = options.onSaveDialog;
    this.quickPickHandler = options.onQuickPick;
    this.inputBoxHandler = options.onInputBox;
    this.openExternalHandler = options.onOpenExternal;
    this.onWebviewPanelHandler = options.onWebviewPanel;
  }

  /**
   * 把界面发回来的一条消息投给对应面板的回调。
   *
   * 返回 false 表示这个 panelId 不是本 shim 开出去的（宿主据此判断「没人认领」）。
   */
  deliverPanelMessage(panelId: string, message: any): boolean {
    const entry = this.webviewPanels.get(panelId);
    if (!entry || entry.disposed) return false;
    entry.messageHandlers.forEach((handler) => {
      try {
        handler(message);
      } catch (err) {
        console.error('[VSCodeShim] 面板消息回调抛错：', err);
      }
    });
    return true;
  }

  /**
   * 关掉一个面板（渲染层把标签关了）。
   *
   * 必须触发 `panel.onDidDispose`：扩展用它在 `sessionPanels` 里注销这个会话，
   * 不触发的话扩展会一直以为「这个会话已经开在某个面板里」，之后再点就什么都不发生。
   */
  disposePanel(panelId: string): boolean {
    const entry = this.webviewPanels.get(panelId);
    if (!entry) return false;
    this.closePanel(panelId);
    return true;
  }

  private closePanel(panelId: string): void {
    const entry = this.webviewPanels.get(panelId);
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    this.webviewPanels.delete(panelId);
    try {
      entry.backend.dispose();
    } catch (err) {
      console.error('[VSCodeShim] 面板 backend.dispose 抛错：', err);
    }
    entry.disposeCallbacks.forEach((callback) => {
      try {
        callback();
      } catch (err) {
        console.error('[VSCodeShim] 面板 onDidDispose 回调抛错：', err);
      }
    });
  }

  /**
   * 用户打开的工作区变了。
   *
   * 扩展宿主的 `workspaceRoot` 是启动时按应用数据目录给的，而扩展真正认的
   * 「这个项目」是用户打开的那个 —— 不改过来，`workspace.workspaceFolders` 会一直
   * 指向应用数据目录（Claude Code 的会话就是按它分组的）。
   */
  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
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
        /**
         * 三个提示。
         *
         * 以前只往 `onMessage` 丢一条消息，而宿主那边转发出去之后**渲染层没人听** ——
         * 扩展说「保存失败」等于没说。现在由宿主弹成 toast。
         * 装了 notify 就交给它，没装才退回原来的通道（纯 Node 验证脚本走那条）。
         */
        showInformationMessage(message: string, ...items: any[]) {
          if (self.notifyHandler) self.notifyHandler('info', String(message));
          else self.onMessageHandler({ type: 'info', message, items });
          return Promise.resolve(undefined);
        },
        showWarningMessage(message: string, ...items: any[]) {
          if (self.notifyHandler) self.notifyHandler('warning', String(message));
          else self.onMessageHandler({ type: 'warning', message, items });
          return Promise.resolve(undefined);
        },
        showErrorMessage(message: string, ...items: any[]) {
          if (self.notifyHandler) self.notifyHandler('error', String(message));
          else self.onMessageHandler({ type: 'error', message, items });
          return Promise.resolve(undefined);
        },
        /** 状态栏上的一次性消息（有超时的那个）。当一条 toast 处理。 */
        setStatusBarMessage(message: string) {
          self.notifyHandler?.('info', String(message));
          return { dispose() {} };
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
        /**
         * 扩展开一个 webview 面板（编辑器标签形态的界面）。
         *
         * Claude Code 的「+」（新会话）就是走这里：扩展判定「新会话该开在面板里」，
         * 于是 new 一个面板、把 HTML 塞进来。以前这整个方法是个空壳 ——
         * HTML 被丢掉、面板不会出现，而扩展那边已经把会话记成「在面板里」，
         * 侧栏因此被清空：用户看到的正是「点 + 没生效，当前窗口却被重置了」。
         *
         * 现在真正的实现在宿主（backend），shim 只负责把 VS Code 的 API 形状摆对。
         */
        createWebviewPanel(viewType: string, title: string, showOptions: any, options?: any) {
          const backend = self.onWebviewPanelHandler?.({
            viewType,
            title,
            options,
            extensionId: self.activeExtensionId,
          });
          if (!backend) {
            // 宿主没实现（纯 Node 验证脚本）：退回空壳，别让扩展的后续代码炸
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
          }

          const entry = {
            messageHandlers: new Set<(message: any) => void>(),
            disposeCallbacks: new Set<() => void>(),
            backend,
            disposed: false,
          };
          self.webviewPanels.set(backend.panelId, entry);
          let panelOptions: any = options || {};

          const webview = {
            set html(value: string) {
              backend.setHtml(String(value ?? ''));
            },
            get html() {
              return '';
            },
            get options() {
              return panelOptions;
            },
            set options(value: any) {
              panelOptions = value;
            },
            onDidReceiveMessage(callback: (message: any) => void) {
              entry.messageHandlers.add(callback);
              return {
                dispose() {
                  entry.messageHandlers.delete(callback);
                },
              };
            },
            postMessage(message: any) {
              return Promise.resolve(backend.postMessage(message)).then(() => true);
            },
            asWebviewUri(uri: vscode.Uri) {
              return backend.asWebviewUri(uri);
            },
            cspSource: backend.cspSource,
          };

          return {
            webview,
            viewType,
            title,
            viewColumn: showOptions?.viewColumn ?? 1,
            options: panelOptions,
            iconPath: undefined,
            active: true,
            visible: true,
            reveal() {
              backend.reveal();
            },
            dispose() {
              self.closePanel(backend.panelId);
            },
            onDidDispose(callback: () => void) {
              entry.disposeCallbacks.add(callback);
              return {
                dispose() {
                  entry.disposeCallbacks.delete(callback);
                },
              };
            },
            onDidChangeViewState: () => ({ dispose() {} }),
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
              self.activeExtensionPath ?? self.extensionPath,
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
          self.customEditorProviders.set(viewType, {
            provider,
            options,
            // 归属和命令/视图一样按「activate 期间是谁」记：禁用/卸载要按它摘掉，
            // 界面也要知道「这个 viewType 是哪个扩展给的」才好把文件交给它。
            extensionId: self.activeExtensionId,
          });
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
        /**
         * 选择列表 / 输入框 / 文件对话框 / 带进度的任务。
         *
         * 这四样以前一律「返回 undefined」= 用户点了取消。后果是 Office Viewer 的
         * 「插入图片」「导出 PDF」「选择导出目录」点下去**毫无反应** ——
         * 从用户视角看就是插件坏了，而实际上是我们把它的对话框吞了。
         * 现在交给宿主用系统对话框实现（没注入时仍然退回「取消」，语义不变）。
         */
        showQuickPick(items: any, options?: any) {
          if (!self.quickPickHandler) return Promise.resolve(undefined);
          // 官方允许传 Promise / Thenable，先解开再交给宿主
          return Promise.resolve(items)
            .then((resolved) => self.quickPickHandler!(resolved ?? [], options))
            .catch(() => undefined);
        },
        showInputBox(options?: any) {
          // 系统对话框没有「输入一行文本」这种形态；宿主没实现就还是「取消」
          return Promise.resolve(self.inputBoxHandler ? self.inputBoxHandler(options) : undefined);
        },
        withProgress(_options?: any, task?: any) {
          if (typeof task !== 'function') return Promise.resolve(undefined as any);
          const token = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose() {} }),
          };
          // 进度本身不画到界面上（没有对应的 UI），但**任务要真的跑** ——
          // 以前这里直接 resolve(undefined)，导出这种「跑起来才有结果」的功能
          // 就永远停在原地。
          return Promise.resolve(task({ report() {} }, token)) as Promise<any>;
        },
        showWorkspaceFolderPick() {
          return Promise.resolve(
            self.workspaceRoot
              ? { uri: ShimUri.file(self.workspaceRoot), name: 'workspace', index: 0 }
              : undefined,
          );
        },
        showOpenDialog(options?: any) {
          return Promise.resolve(
            self.openDialogHandler ? self.openDialogHandler(options) : undefined,
          );
        },
        showSaveDialog(options?: any) {
          return Promise.resolve(
            self.saveDialogHandler ? self.saveDialogHandler(options) : undefined,
          );
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
        /**
         * 当前打开的工作区。
         *
         * **必须是 getter**：扩展宿主是用 `app.getPath('userData')` 建起来的，用户在
         * 界面里打开的项目要能改到它（`setWorkspaceRoot`）。以前这里是一次性快照，
         * 于是扩展看到的「工作区」永远是应用数据目录 —— Claude Code 的会话列表、
         * 按工作区取配置这些全落在错的地方。
         */
        get workspaceFolders() {
          const root = self.workspaceRoot;
          if (!root) return undefined;
          return [
            {
              uri: ShimUri.file(root),
              name: root.split(/[\\/]/).pop() || 'workspace',
              index: 0,
            },
          ];
        },
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
        /**
         * 落盘扩展提交的编辑。
         *
         * 以前这里无条件 `return true` —— 对扩展来说是「改好了」，对用户来说是
         * 「什么都没发生」：Office Viewer 保存 markdown 就是走这条路，
         * 谎报成功的结果是编辑器的改动被静默丢掉。现在老老实实交给宿主去写，
         * 没接宿主就返回 false（扩展自己能看出失败）。
         */
        applyEdit(edit: any) {
          const handler = self.onApplyEditHandler;
          if (!handler) return Promise.resolve(false);
          const descriptor =
            edit && typeof edit.describe === 'function'
              ? (edit.describe() as WorkspaceEditDescriptor)
              : (edit as WorkspaceEditDescriptor);
          if (!descriptor?.textEdits && !descriptor?.fileOps) return Promise.resolve(false);
          return handler(descriptor).catch((err) => {
            console.error('[vscode-shim] applyEdit 落盘失败:', err);
            return false;
          });
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
        /**
         * `workspace.fs` —— 扩展读写文件的官方通道。
         *
         * 以前这里是**空对象**：Office Viewer 的表格/文档/压缩包预览全靠它读二进制
         * （xlsx、docx 不是文本），少一个方法就是 TypeError。这里接到真实 fs 上，
         * 路径从 `Uri.fsPath` 取（也有扩展直接传字符串，一并收下）。
         */
        fs: {
          async readFile(uri: any) {
            const fsPromises = require('fs/promises');
            return new Uint8Array(await fsPromises.readFile(fsPathOfUri(uri)));
          },
          async writeFile(uri: any, content: Uint8Array) {
            const fsPromises = require('fs/promises');
            await fsPromises.writeFile(fsPathOfUri(uri), Buffer.from(content));
          },
          async stat(uri: any) {
            const fsPromises = require('fs/promises');
            const info = await fsPromises.stat(fsPathOfUri(uri));
            return {
              type: info.isDirectory()
                ? 2 // FileType.Directory
                : info.isFile()
                  ? 1 // FileType.File
                  : 64, // FileType.SymbolicLink
              ctime: info.ctimeMs,
              mtime: info.mtimeMs,
              size: info.size,
              permissions: undefined,
            };
          },
          async readDirectory(uri: any) {
            const fsPromises = require('fs/promises');
            const entries = await fsPromises.readdir(fsPathOfUri(uri), { withFileTypes: true });
            // 返回 [名字, FileType] 的二元组数组 —— 这是官方形状
            return entries.map((entry: any) => [
              entry.name,
              entry.isDirectory() ? 2 : entry.isFile() ? 1 : 64,
            ]);
          },
          async createDirectory(uri: any) {
            const fsPromises = require('fs/promises');
            await fsPromises.mkdir(fsPathOfUri(uri), { recursive: true });
          },
          async delete(uri: any, options?: { recursive?: boolean }) {
            const fsPromises = require('fs/promises');
            await fsPromises.rm(fsPathOfUri(uri), {
              recursive: options?.recursive === true,
              force: true,
            });
          },
          async rename(oldUri: any, newUri: any, options?: { overwrite?: boolean }) {
            const fsPromises = require('fs/promises');
            if (options?.overwrite !== false) {
              await fsPromises.rm(fsPathOfUri(newUri), { force: true });
            }
            await fsPromises.rename(fsPathOfUri(oldUri), fsPathOfUri(newUri));
          },
          async copy(source: any, target: any, options?: { overwrite?: boolean }) {
            const fsPromises = require('fs/promises');
            if (options?.overwrite !== false) {
              await fsPromises.rm(fsPathOfUri(target), { force: true });
            }
            await fsPromises.cp(fsPathOfUri(source), fsPathOfUri(target), { recursive: true });
          },
          isWritableFileSystem() {
            return true;
          },
        } as any,
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

      /**
       * `vscode.Uri`。
       *
       * 实现搬到 `./uri`（`ShimUri`）是因为宿主进程也要造 Uri（给自定义编辑器的
       * `document.uri`）—— 那边直接 import 这个类，而不是再手搓一个字面量对象。
       * 为什么必须有 `with()`，见 `uri.ts` 文件头。
       *
       * `joinPath` 单独留一条注释：以前这里 `return uri`（把片段全丢了），后果不是
       * 「少一个功能」而是**整个界面起不来** —— 扩展用
       * `Uri.joinPath(extensionUri, 'webview', 'index.js')` 定位自己的 bundle，
       * 拿回来的却是扩展根目录。
       */
      Uri: ShimUri as any,

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
      /**
       * 运行界面形态。
       *
       * 数字必须和官方一致（Web = 1，Desktop = 2）：扩展会拿它和 `env.uiKind` 比，
       * 比错了会走错分支（Office Viewer 用 `uiKind === UIKind.Web` 决定要不要列出盘符，
       * 站错边就是一行 `undefined.Web` 的 TypeError）。
       */
      UIKind: { Web: 1, Desktop: 2 },

      // Languages API (minimal)
      languages: makeLanguagesNamespace(),

      // Environment
      env: {
        appName: 'Deepseek IDE',
        appRoot: this.extensionPath,
        language: 'zh-cn',
        clipboard: {
          readText() {
            return self.clipboardHandler?.readText() ?? Promise.resolve('');
          },
          writeText(text: string) {
            return self.clipboardHandler?.writeText(text) ?? Promise.resolve();
          },
        },
        machineId: 'unknown-machine-id',
        sessionId: 'unknown-session-id',
        remoteName: '',
        shell: process.env.SHELL || '/bin/bash',
        uiKind: 2, // UIKind.Desktop（官方取值：Web = 1，Desktop = 2）
        /**
         * 用系统浏览器打开链接。
         *
         * 以前无条件返回 `true` 却什么都不做 —— 扩展以为链接打开了，用户什么都没看到。
         * 现在是真打开（扩展界面的「Learn more」「主页」这类全走这里）。
         */
        openExternal(target: any) {
          const url = typeof target === 'string' ? target : String(target?.toString?.() ?? target);
          if (!self.openExternalHandler) return Promise.resolve(true);
          return self.openExternalHandler(url);
        },
        asExternalUri(target: vscode.Uri) {
          return Promise.resolve(target);
        },
        uriScheme: 'vscode',
        logLevel: 1, // LogLevel.Info
        onDidChangeLogLevel: () => ({ dispose() {} }),
        /**
         * 遥测记录器。
         *
         * 我们不上报遥测，但**形状要给全**：扩展会连着调 logError / logUsage /
         * sendEventData，并读 isErrorsEnabled / onDidChangeEnableStates。
         * 少一个就是 activate 里的 TypeError（Office Viewer 就栽在这上面）。
         */
        createTelemetryLogger(_scope?: any, _options?: any) {
          const noop = () => {};
          return {
            logError: noop,
            logUsage: noop,
            logInfo: noop,
            logDebug: noop,
            logWarning: noop,
            logVerbose: noop,
            sendEventData: noop,
            onDidChangeEnableStates: () => ({ dispose() {} }),
            // 一律「关闭」，与上面 isTelemetryEnabled: false 保持一致
            isUsageEnabled: false,
            isErrorsEnabled: false,
            isCrashEnabled: false,
            dispose: noop,
          } as any;
        },
        isNewAppInstall: false,
        isTelemetryEnabled: false,
        onDidChangeTelemetryEnabled: () => ({ dispose() {} }),
        appHost: 'desktop',
      } as any,

      // Extensions (minimal)
      extensions: {
        /**
         * 真的装了才返回对象，没装就是 `undefined`。
         *
         * 以前这里对**任何** id 都返回一个 `exports: {}` 的假对象。看起来「更宽容」，
         * 实际上是把扩展推进沟里：Office Viewer 在模块顶层找 `vscode.git`，
         * 假对象的 `exports.getAPI` 不存在却也不是 undefined —— `?.` 拦不住，
         * 直接 TypeError，还落在一条没人 await 的 async 链上（只剩一条 unhandledRejection）。
         * 而扩展普遍写的是 `if (!git) return …`，`undefined` 正是它们期望的分支。
         *
         * 登记簿在 `loadExtension` 读完 manifest 时写入（早于模块加载），
         * 停用时由 ExtensionHost 摘掉。见 `./extensionRegistry`。
         */
        getExtension(extensionId?: string) {
          const id = String(extensionId ?? '').trim();
          if (!id) return undefined;
          const registered = getRegisteredExtension(id);
          if (!registered) return undefined;
          const parts = id.split('.');
          const extensionPath = registered.extensionPath;
          return {
            id,
            extensionUri: ShimUri.file(extensionPath),
            extensionPath,
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
            // activate 之后是真模块导出（调用方可能真去调它的 API）
            exports: registered.exports ?? {},
            activate() {
              return Promise.resolve();
            },
            extensionKind: 1,
          };
        },
        /**
         * 装了哪些扩展。
         *
         * 以前恒为 `[]`。现在按登记簿给真值 —— 扩展会用 `extensions.all.find(...)`
         * 找同伴（比如找 vscode.git 的 id 是不是装了），恒空会走错分支。
         */
        get all() {
          return listRegisteredExtensionIds().map((id) => ({
            id,
            extensionPath: getRegisteredExtension(id)?.extensionPath ?? self.extensionPath,
            isActive: true,
            extensionKind: 1,
          }));
        },
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
      Range: Range as any,
      Position: Position as any,
      Selection: Selection as any,
      Location: class Location {} as any,
      Diagnostic: class Diagnostic {} as any,
      DiagnosticRelatedInformation: class DiagnosticRelatedInformation {} as any,
      WorkspaceEdit: WorkspaceEdit as any,
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
  /**
   * 已注册的自定义编辑器（带归属）。
   *
   * 宿主用它做两件事：把 manifest 里的 `contributes.customEditors` 和这里的
   * provider 对上（只有真的注册了 provider 才能开工），以及禁用/卸载时摘掉。
   */
  listCustomEditorProviders(): { viewType: string; extensionId?: string; options?: any }[] {
    return Array.from(this.customEditorProviders.entries()).map(([viewType, entry]) => ({
      viewType,
      extensionId: entry.extensionId,
      options: entry.options,
    }));
  }

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
    for (const [viewType, entry] of Array.from(this.customEditorProviders.entries())) {
      if (entry.extensionId === extensionId) this.customEditorProviders.delete(viewType);
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
    this.customEditorProviders.clear();
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
    extensionUri: ShimUri.file(extensionPath),
    asAbsolutePath(relativePath: string) {
      return require('path').join(extensionPath, relativePath);
    },
    storageUri: ShimUri.file(extensionPath),
    globalStorageUri: ShimUri.file(extensionPath),
    logUri: ShimUri.file(extensionPath),
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
      extensionUri: ShimUri.file(extensionPath),
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
