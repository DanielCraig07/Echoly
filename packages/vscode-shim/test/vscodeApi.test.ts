import { describe, expect, it } from 'vitest';
import { VSCodeShim, VSCODE_API_WHITELIST } from '../src/index';

/**
 * vscode API 表面的回归测试。
 *
 * 为什么值得单独钉住：shim 少一个方法，表现不是「这个功能不好用」，而是
 * **整个扩展激活失败** —— 界面上只有一句「已安装，但激活失败：… is not a function」。
 * 实测：`es6kr.claude-sessions`（Claude Code Sessions）在 activate() 里第一件事
 * 就是调 `window.registerCustomEditorProvider`，缺它整个扩展起不来（已补）。
 *
 * 所以这里断言的不是「函数好不好用」，而是「这批扩展在激活早期一定会碰到的入口
 * 必须存在」。清单里每一条都来自真实扩展的激活路径，不是照着 VS Code 文档抄的。
 */

const createApi = () => {
  const shim = new VSCodeShim({
    workspaceRoot: '/tmp/echoly-shim-test',
    extensionPath: '/tmp/echoly-shim-test',
    onCommand: async () => undefined,
    onMessage: () => {},
  });
  return shim.createAPI() as any;
};

/** 按 `a.b.c` 取值，任一段缺失就返回 undefined（用来断言存在性而不是崩掉）。 */
const pick = (obj: any, path: string): any =>
  path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);

describe('vscode API 表面', () => {
  it('registerCustomEditorProvider 在位，且返回真的 Disposable', () => {
    const api = createApi();
    expect(typeof api.window.registerCustomEditorProvider).toBe('function');
    const registration = api.window.registerCustomEditorProvider('demo.jsonlPreview', {});
    expect(typeof registration.dispose).toBe('function');
    expect(() => registration.dispose()).not.toThrow();
  });

  it('registerWebviewViewProvider 把 viewId 交给宿主（Claude Code 的侧栏靠它）', () => {
    const seen: string[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/x',
      extensionPath: '/tmp/x',
      onCommand: async () => undefined,
      onMessage: () => {},
      onWebviewViewRegister: (viewId) => seen.push(viewId),
    });
    const api = shim.createAPI() as any;
    api.window.registerWebviewViewProvider('claudeVSCodeSidebar', { resolveWebviewView() {} });
    expect(seen).toEqual(['claudeVSCodeSidebar']);
  });

  it('扩展激活早期会碰到的入口都在位', () => {
    const api = createApi();
    const required = [
      'commands.registerCommand',
      'commands.executeCommand',
      'window.registerCustomEditorProvider',
      'window.registerWebviewViewProvider',
      'window.registerWebviewPanelSerializer',
      'window.registerTreeDataProvider',
      'window.registerUriHandler',
      'window.createStatusBarItem',
      'window.createOutputChannel',
      'window.showInformationMessage',
      'window.showErrorMessage',
      'window.showQuickPick',
      'window.showInputBox',
      'workspace.getConfiguration',
      'workspace.onDidChangeConfiguration',
      'workspace.registerTextDocumentContentProvider',
      'languages.registerCompletionItemProvider',
      'extensions.getExtension',
      'RelativePattern',
      'CodeActionKind',
      'languages.createLanguageStatusItem',
      'Uri.file',
      'EventEmitter',
      'Disposable',
    ];
    const missing = required.filter((path) => typeof pick(api, path) !== 'function');
    expect(missing).toEqual([]);
  });

  it('RelativePattern 收得下三种 base（工作区文件夹 / Uri / 字符串）', () => {
    const api = createApi();
    // 实测 vishalguptax.claude-manager 在 activate 里 new 它，缺了这个类整个扩展激活失败
    const fromFolder = new api.RelativePattern({ uri: api.Uri.file('/tmp/ws') }, '**/*.jsonl');
    expect(fromFolder.pattern).toBe('**/*.jsonl');
    expect(fromFolder.baseUri.fsPath).toBe('/tmp/ws');
    expect(fromFolder.base).toBe('/tmp/ws');

    const fromUri = new api.RelativePattern(api.Uri.file('/tmp/other'), 'a/*');
    expect(fromUri.base).toBe('/tmp/other');

    const fromString = new api.RelativePattern('/tmp/plain', 'b/*');
    expect(fromString.base).toBe('/tmp/plain');
  });

  it('CodeActionKind 是带值的类，append / contains / intersects 都在', () => {
    const api = createApi();
    // 实测 esbenp.prettier-vscode@12 在**模块顶层**就调 SourceFixAll.append(...)，
    // 缺了它连 activate 都到不了（主模块加载阶段就崩）
    expect(api.CodeActionKind.SourceFixAll.append('json').value).toBe('source.fixAll.json');
    // contains 的方向是「父 contains 子」（官方定义：other 是不是 this 的子种类）
    expect(api.CodeActionKind.Refactor.contains(api.CodeActionKind.RefactorExtract)).toBe(true);
    expect(
      api.CodeActionKind.Refactor.contains(api.CodeActionKind.Refactor.append('extract')),
    ).toBe(true);
    expect(api.CodeActionKind.Source.contains(api.CodeActionKind.SourceOrganizeImports)).toBe(true);
    expect(api.CodeActionKind.Source.contains(api.CodeActionKind.Refactor)).toBe(false);
    expect(api.CodeActionKind.Refactor.intersects(api.CodeActionKind.RefactorExtract)).toBe(true);
    expect(String(api.CodeActionKind.Source)).toBe('source');
  });

  it('createLanguageStatusItem 返回形状完整的对象（缺字段会在后续赋值时异步炸）', () => {
    const api = createApi();
    const item = api.languages.createLanguageStatusItem('prettier.status', { language: '*' });
    expect(item.id).toBe('prettier.status');
    expect(item.severity).toBe(0);
    expect(() => {
      item.text = 'Prettier';
      item.severity = api.LanguageStatusSeverity.Warning;
      item.busy = true;
      item.dispose();
    }).not.toThrow();
    expect(item.severity).toBe(1);
  });

  it('findFiles / createFileSystemWatcher 收得下 RelativePattern，且如实返回空', async () => {
    const api = createApi();
    const pattern = new api.RelativePattern('/tmp/ws', '**/*.ts');
    await expect(api.workspace.findFiles(pattern, undefined, 10)).resolves.toEqual([]);
    const watcher = api.workspace.createFileSystemWatcher(pattern);
    expect(typeof watcher.onDidChange).toBe('function');
    expect(typeof watcher.dispose).toBe('function');
  });

  it('白名单外的命名空间不直接抛错（扩展会访问到，缺了就是崩在 activate 里）', () => {
    expect(VSCODE_API_WHITELIST.has('window')).toBe(true);
    expect(VSCODE_API_WHITELIST.has('debug')).toBe(false);
    const api = createApi();
    // 未列白名单的命名空间要走 stub 而不是 undefined，否则 `vscode.debug.x` 直接 TypeError
    expect(api.debug).toBeTruthy();
  });
});
