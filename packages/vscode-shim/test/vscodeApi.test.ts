import { describe, expect, it } from 'vitest';
import { VSCodeShim, VSCODE_API_WHITELIST } from '../src/index';
import {
  registerExtension,
  resetExtensionRegistry,
  setExtensionExports,
} from '../src/extensionRegistry';

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

describe('Uri.joinPath 真的拼路径（扩展界面的资源全靠它）', () => {
  /**
   * 这条以前是坏的：`joinPath` 直接 `return uri`，把片段全丢了。
   *
   * 后果不是「少一个功能」而是**整个扩展界面起不来** —— 扩展用
   * `Uri.joinPath(extensionUri, 'webview', 'index.js')` 定位自己的 bundle，
   * 拿回来的是扩展根目录，于是界面里的 script src 指向一个目录，浏览器报
   * 「webview/index.js could not be fetched」（Claude Code 的面板就是这么挂的）。
   */
  it('把片段接到 uri 后面，而不是原样返回', () => {
    const api = createApi();
    const base = api.Uri.file('/tmp/ext');

    const joined = api.Uri.joinPath(base, 'webview', 'index.js');
    expect(joined.fsPath).toBe('/tmp/ext/webview/index.js');
    // 原 uri 不能被就地改掉：同一个 extensionUri 后面还会被用
    expect(base.fsPath).toBe('/tmp/ext');
  });

  it('结果能直接当 asWebviewUri 的输入（也就是能进 <script src>）', () => {
    const api = createApi();
    const uri = api.Uri.joinPath(api.Uri.file('/tmp/ext'), 'webview', 'index.js');
    // 扩展那边会写 `src="${asWebviewUri(uri)}"`，所以这里断言的是「取得到路径」
    expect(String(uri.fsPath)).toMatch(/index\.js$/);
  });
});

describe('命令 / 视图的归属登记（禁用与卸载靠它）', () => {
  /**
   * 为什么需要这套登记：扩展在 activate() 里调 registerCommand / registerWebviewViewProvider
   * 时**不会自报家门**。禁用与卸载却必须知道「这些命令与视图是哪个扩展注册的」，
   * 才能把它们一起摘掉 —— 否则一个被停用的扩展的命令还留在命令面板里，点下去毫无反应。
   *
   * 归属靠「activate 期间设 activeExtensionId」推断，所以这里按真实调用顺序测：
   * 设 id → 注册 → 清 id。
   */
  const setup = () => {
    const registrations: { viewId: string; extensionId?: string }[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/x',
      extensionPath: '/tmp/x',
      onCommand: async () => undefined,
      onMessage: () => {},
      onWebviewViewRegister: (viewId, _provider, _path, _options, extensionId) =>
        registrations.push({ viewId, extensionId }),
    });
    return { shim, api: shim.createAPI() as any, registrations };
  };

  it('激活期间注册的命令与视图都记在当次激活的扩展名下', () => {
    const { shim, api, registrations } = setup();

    shim.activeExtensionId = 'a.demo';
    api.commands.registerCommand('a.demo.doThing', () => 1);
    api.window.registerWebviewViewProvider('a.demoView', { resolveWebviewView() {} });
    shim.activeExtensionId = undefined;

    expect(shim.listCommands()).toEqual([{ command: 'a.demo.doThing', extensionId: 'a.demo' }]);
    expect(shim.listWebviewViewIds('a.demo')).toEqual(['a.demoView']);
    // 宿主（manager）也要能拿到归属，它另有 provider 表要一起清
    expect(registrations).toEqual([{ viewId: 'a.demoView', extensionId: 'a.demo' }]);
  });

  it('dropExtensionRegistrations 只摘掉指定扩展的，不碰别人的', () => {
    const { shim, api } = setup();

    shim.activeExtensionId = 'a.demo';
    api.commands.registerCommand('a.demo.cmd', () => 1);
    api.window.registerWebviewViewProvider('a.demoView', {});
    shim.activeExtensionId = 'b.other';
    api.commands.registerCommand('b.other.cmd', () => 2);
    api.window.registerWebviewViewProvider('b.otherView', {});
    shim.activeExtensionId = undefined;

    const droppedViews = shim.dropExtensionRegistrations('a.demo');

    expect(droppedViews).toEqual(['a.demoView']);
    expect(shim.listCommands()).toEqual([{ command: 'b.other.cmd', extensionId: 'b.other' }]);
    expect(shim.listWebviewViewIds('a.demo')).toEqual([]);
    expect(shim.listWebviewViewIds('b.other')).toEqual(['b.otherView']);
    // 命令是真被摘了：执行它不再有响应
    return expect(shim.executeCommand('a.demo.cmd')).resolves.toBeUndefined();
  });

  it('扩展自己 dispose 掉注册项之后，归属表也不该留残渣', () => {
    const { shim, api } = setup();

    shim.activeExtensionId = 'a.demo';
    const cmd = api.commands.registerCommand('a.demo.cmd', () => 1);
    const view = api.window.registerWebviewViewProvider('a.demoView', {});
    shim.activeExtensionId = undefined;

    cmd.dispose();
    view.dispose();

    // 没清干净的话，禁用/卸载会去摘一个本就不存在的项，或反过来漏摘
    expect(shim.listCommands()).toEqual([]);
    expect(shim.listWebviewViewIds('a.demo')).toEqual([]);
  });

  it('activate 之外注册的命令没有归属（不该被算到某个扩展头上）', () => {
    const { shim, api } = setup();
    api.commands.registerCommand('builtin.cmd', () => 1);
    expect(shim.listCommands()).toEqual([{ command: 'builtin.cmd', extensionId: undefined }]);
  });
});

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

describe('Uri.with —— 少它整个自定义编辑器渲染不出来', () => {
  /**
   * 这条是 Office Viewer 的 markdown 编辑器踩出来的。
   *
   * `resolveCustomTextEditor` 里先 `Vce(documentUri, handler)`，而
   * `Vce` 第一件事就是 `uri.with({ query: '', fragment: '' }).toString()`。
   * 老 shim 的 Uri 是个只有 `fsPath`/`scheme`/`toString` 的字面量对象，
   * `t.with is not a function` 把 `handleMarkdown` 打断在开头 —— 而它在调用处
   * **没有 await**（扩展写的），异常不会冒到 `resolveCustomTextEditor`，
   * 只留下一条 unhandledRejection。界面上看不出任何报错，只有「装了、点了没反应」。
   */
  it('with() 换掉指定段，其余原样带过去', () => {
    const api = createApi();
    const uri = api.Uri.parse('file:///tmp/a.md?x=1#frag');

    const cleaned = uri.with({ query: '', fragment: '' });
    expect(cleaned.fsPath).toBe('/tmp/a.md');
    expect(cleaned.query).toBe('');
    expect(cleaned.fragment).toBe('');
    // 原对象不能被就地改：同一个 uri 后面还要用
    expect(uri.query).toBe('x=1');
    expect(uri.fragment).toBe('frag');
  });

  it('joinPath 会规范化 `..`（拿父目录就是这么拿的）', () => {
    const api = createApi();
    const parent = api.Uri.joinPath(api.Uri.file('/tmp/proj/notes/a.md'), '..');

    expect(parent.fsPath).toBe('/tmp/proj/notes');
  });

  it('parse 认得协议头，认不出就当本地路径', () => {
    const api = createApi();
    expect(api.Uri.parse('https://example.com/a/b').scheme).toBe('https');
    expect(api.Uri.parse('https://example.com/a/b').authority).toBe('example.com');
    expect(api.Uri.parse('/tmp/a.md').scheme).toBe('file');
    expect(api.Uri.parse('/tmp/a.md').fsPath).toBe('/tmp/a.md');
  });

  it('file 协议的 toString() 仍然是磁盘路径（老行为，不改）', () => {
    const api = createApi();
    expect(api.Uri.file('/tmp/a.md').toString()).toBe('/tmp/a.md');
  });
});

describe('extensions.getExtension —— 没装就该是 undefined', () => {
  /**
   * 以前对**任何** id 都返回一个 `exports: {}` 的假对象。看起来更宽容，实际上
   * 是把扩展推进沟里：Office Viewer 在模块顶层找 `vscode.git`，假对象的
   * `exports.getAPI` 不是函数（`?.` 拦不住），直接 TypeError；而它在一条没人 await
   * 的 async 链上，只剩一条 unhandledRejection。
   *
   * 官方的语义是没装就 undefined —— 扩展普遍写成 `if (!git) return`，
   * 那正是它们期望的分支。
   */
  it('没登记过的扩展返回 undefined', () => {
    resetExtensionRegistry();
    const api = createApi();
    expect(api.extensions.getExtension('vscode.git')).toBeUndefined();
    expect(api.extensions.getExtension('')).toBeUndefined();
  });

  it('登记过的给出真路径，activate 之后 exports 是真导出', () => {
    resetExtensionRegistry();
    registerExtension('cweijan.vscode-office', '/tmp/ext/office');
    setExtensionExports('cweijan.vscode-office', { activate() {} });

    const api = createApi();
    const ext = api.extensions.getExtension('cweijan.vscode-office');
    expect(ext.extensionPath).toBe('/tmp/ext/office');
    expect(ext.extensionUri.fsPath).toBe('/tmp/ext/office');
    expect(typeof ext.exports.activate).toBe('function');

    // 大小写不敏感（官方也是这个规则）
    expect(api.extensions.getExtension('CWEIJAN.VSCODE-OFFICE')).toBeTruthy();
    resetExtensionRegistry();
  });
});

describe('WorkspaceEdit → applyEdit 真的交给宿主', () => {
  /**
   * 以前 `applyEdit` 无条件 `return true`：对扩展是「改好了」，对用户是
   * 「什么都没发生」——Office Viewer 保存 markdown 走的就是这条路，
   * 谎报成功的结果是用户的编辑被静默丢掉。
   */
  it('把 Range/Position 翻译成宿主能落盘的描述', async () => {
    const captured: any[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/echoly-shim-test',
      extensionPath: '/tmp/echoly-shim-test',
      onCommand: async () => undefined,
      onMessage: () => {},
      onApplyEdit: async (edit) => {
        captured.push(edit);
        return true;
      },
    });
    const api = shim.createAPI() as any;

    const edit = new api.WorkspaceEdit();
    edit.replace(api.Uri.file('/tmp/a.md'), new api.Range(0, 0, 3, 0), 'new text');

    await expect(api.workspace.applyEdit(edit)).resolves.toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].textEdits).toEqual([
      {
        fsPath: '/tmp/a.md',
        startLine: 0,
        startCharacter: 0,
        endLine: 3,
        endCharacter: 0,
        newText: 'new text',
      },
    ]);
  });

  it('没接宿主时返回 false —— 不谎报成功', async () => {
    const api = createApi();
    const edit = new api.WorkspaceEdit();
    edit.replace(api.Uri.file('/tmp/a.md'), new api.Range(0, 0, 0, 0), 'x');
    await expect(api.workspace.applyEdit(edit)).resolves.toBe(false);
  });
});
