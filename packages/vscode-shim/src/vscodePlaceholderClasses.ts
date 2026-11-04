/**
 * vscode 官方**类**的形状占位。
 *
 * 与 `vscodeEnums.ts` 同一个理由，但代价与收益要说清楚：
 * - 缺一个枚举 → 扩展**主模块加载失败**（`undefined.Workspace`），整个扩展消失；
 * - 缺一个类 → 扩展 `activate()` 里 `new vscode.FoldingRange(...)` 抛
 *   `vscode.FoldingRange is not a constructor`，同样整个扩展起不来。
 *
 * 这些类对应的多是语言特性 / Notebook / 测试 / 调试等**我们本来就不提供的能力**，
 * 所以这里给的是**形状**：能 new、能当 `instanceof` 目标、构造参数原样留着，但没有真实行为。
 * 取舍是「扩展能装、能激活、界面上是『已启用』」优先于「诚实地告诉用户激活失败了」——
 * 绝大多数扩展只用其中一两个类，为一个无关能力把整个扩展摁死并不划算。
 *
 * 需要真实现时，把它从这份名单里拿掉、在 `index.ts` 里写真正的类
 * （`Range`、`Position`、`Uri`、`CompletionItem` 等已经是真实现，不在名单里）。
 */

/**
 * 造一个形状占位类。
 *
 * `new` 出来的对象带 `_args`（构造参数原样留着，排查时能看出扩展想建什么）与
 * `dispose()`（扩展普遍把它当 disposable 收进 subscriptions）。
 */
function makePlaceholderClass(name: string): any {
  return class Placeholder {
    /** 构造参数原样留着：排查「这个类被拿去当什么用」时是唯一的线索。 */
    readonly _args: unknown[];
    constructor(...args: unknown[]) {
      this._args = args;
    }
    dispose(): void {}
    toString(): string {
      return `[vscode-shim placeholder ${name}]`;
    }
  };
}

/** 缺的那些类，按官方名字逐个给一个形状占位。 */
export const VSCODE_PLACEHOLDER_CLASSES: Record<string, any> = Object.fromEntries(
  [
    'CallHierarchyIncomingCall',
    'CallHierarchyItem',
    'CallHierarchyOutgoingCall',
    'Color',
    'ColorInformation',
    'ColorPresentation',
    'CompletionList',
    'CustomExecution',
    'DataTransfer',
    'DataTransferItem',
    'DocumentDropEdit',
    'DocumentDropOrPasteEditKind',
    'DocumentHighlight',
    'DocumentLink',
    'DocumentPasteEdit',
    'DocumentSymbol',
    'EvaluatableExpression',
    'FileDecoration',
    'FoldingRange',
    'InlayHint',
    'InlayHintLabelPart',
    'InlineCompletionItem',
    'InlineCompletionList',
    'InlineValueEvaluatableExpression',
    'InlineValueText',
    'InlineValueVariableLookup',
    'LinkedEditingRanges',
    'NotebookEdit',
    'ParameterInformation',
    'ProcessExecution',
    'QuickInputButtons',
    'SelectionRange',
    'SemanticTokens',
    'SemanticTokensBuilder',
    'SemanticTokensEdit',
    'SemanticTokensEdits',
    'SemanticTokensLegend',
    'ShellExecution',
    'SignatureHelp',
    'SignatureInformation',
    'SnippetTextEdit',
    'SymbolInformation',
    'Task',
    'TaskGroup',
    'TerminalLink',
    'TerminalProfile',
    'TextEdit',
    'TypeHierarchyItem',
  ].map((name) => [name, makePlaceholderClass(name)]),
);

/**
 * `CancellationError` / `FileSystemError` 单独实现：它们是**错误类**，
 * 扩展会 `instanceof Error`、会读 `err.code`，拿占位类糊弄会走进完全错误的分支。
 */
class CancellationErrorShim extends Error {
  constructor() {
    super('CancellationError');
    this.name = 'CancellationError';
  }
}

class FileSystemErrorShim extends Error {
  code: string;
  constructor(messageOrUri?: any, code?: string) {
    const message =
      code === undefined
        ? String(messageOrUri ?? 'FileSystemError')
        : `${String(code)}${messageOrUri && typeof messageOrUri === 'object' && 'fsPath' in messageOrUri ? ` (${messageOrUri.fsPath})` : ''}`;
    super(message);
    this.name = 'FileSystemError';
    this.code = code ?? (typeof messageOrUri === 'string' ? messageOrUri : 'Unknown');
  }

  static FileNotFound(uri: any): FileSystemErrorShim {
    return new FileSystemErrorShim(uri, 'FileNotFound');
  }
  static FileExists(uri: any): FileSystemErrorShim {
    return new FileSystemErrorShim(uri, 'FileExists');
  }
  static FileNotADirectory(uri: any): FileSystemErrorShim {
    return new FileSystemErrorShim(uri, 'FileNotADirectory');
  }
  static FileIsADirectory(uri: any): FileSystemErrorShim {
    return new FileSystemErrorShim(uri, 'FileIsADirectory');
  }
  static NoPermissions(uri: any): FileSystemErrorShim {
    return new FileSystemErrorShim(uri, 'NoPermissions');
  }
  static Unavailable(uri: any): FileSystemErrorShim {
    return new FileSystemErrorShim(uri, 'Unavailable');
  }
}

/** 错误类：形状与官方一致（可 instanceof Error，带 code 与静态构造器）。 */
export const VSCODE_ERROR_CLASSES: Record<string, any> = {
  CancellationError: CancellationErrorShim,
  FileSystemError: FileSystemErrorShim,
};
