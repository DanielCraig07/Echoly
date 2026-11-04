import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VSCodeShim, VSCODE_API_WHITELIST, createExtensionContext } from '../src/index';
import { VSCODE_ENUMS } from '../src/vscodeEnums';
import { VSCODE_ERROR_CLASSES, VSCODE_PLACEHOLDER_CLASSES } from '../src/vscodePlaceholderClasses';
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

describe('扩展「跟用户说话」的那几条路（宿主注入）', () => {
  /**
   * 这一组全是被 Office Viewer 的工具栏逼出来的：它的每个按钮最终都落到
   * 「弹提示 / 开对话框 / 打开外链」这三件事上。以前这些方法一律返回 undefined
   * 或什么都不做 —— 从用户视角看就是「点下去毫无反应」，很容易误判成插件坏了。
   */
  const createApiWithUi = (ui: Record<string, any>) => {
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/echoly-shim-test',
      extensionPath: '/tmp/echoly-shim-test',
      onCommand: async () => undefined,
      onMessage: () => {},
      ...ui,
    });
    return shim.createAPI() as any;
  };

  it('showErrorMessage 走注入的提示通道，而不是发一条没人听的消息', async () => {
    const seen: any[] = [];
    const api = createApiWithUi({
      onNotify: (level: string, message: string) => seen.push([level, message]),
    });
    await api.window.showErrorMessage('保存失败');
    expect(seen).toEqual([['error', '保存失败']]);
  });

  it('没注入提示通道时退回 onMessage（纯 Node 验证脚本走那条）', async () => {
    const messages: any[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/echoly-shim-test',
      extensionPath: '/tmp/echoly-shim-test',
      onCommand: async () => undefined,
      onMessage: (m: any) => messages.push(m),
    });
    await (shim.createAPI() as any).window.showWarningMessage('注意');
    expect(messages[0]).toMatchObject({ type: 'warning', message: '注意' });
  });

  it('打开/保存对话框把结果交回扩展（取消 = undefined，那是正常语义）', async () => {
    const api = createApiWithUi({
      onOpenDialog: async () => ['/tmp/pic.png'],
      onSaveDialog: async () => undefined,
    });
    await expect(api.window.showOpenDialog({ canSelectMany: false })).resolves.toEqual([
      '/tmp/pic.png',
    ]);
    await expect(api.window.showSaveDialog({})).resolves.toBeUndefined();
  });

  it('showQuickPick 返回**原样的 item**，并接受 Promise 形式的列表', async () => {
    const api = createApiWithUi({ onQuickPick: async (items: any[]) => items[1] });
    const picked = await api.window.showQuickPick(
      Promise.resolve([{ label: '是' }, { label: '否' }]),
    );
    expect(picked).toEqual({ label: '否' });
  });

  it('withProgress 真的把任务跑起来（以前直接返回 undefined）', async () => {
    const api = createApiWithUi({});
    const result = await api.window.withProgress(
      { location: 15 },
      async (progress: any, token: any) => {
        expect(typeof progress.report).toBe('function');
        expect(token.isCancellationRequested).toBe(false);
        return 'done';
      },
    );
    expect(result).toBe('done');
  });

  it('env.openExternal 真的交给宿主打开（不再谎报成功）', async () => {
    const opened: string[] = [];
    const api = createApiWithUi({
      onOpenExternal: async (url: string) => (opened.push(url), true),
    });
    await expect(api.env.openExternal(api.Uri.parse('https://example.com/a'))).resolves.toBe(true);
    expect(opened).toEqual(['https://example.com/a']);
  });
});

describe('createWebviewPanel 真的开成一个面板（Claude 的「+」走这里）', () => {
  /**
   * 以前 `createWebviewPanel` 是个**空壳**：`webview.html = …` 被丢掉、
   * 面板不会出现在界面上。Claude Code 点「+」（新会话）正好走这条 ——
   * 于是标签不出现，而扩展那边已经把会话记成「开在面板里」并把侧栏清空。
   * 从用户视角看就是「点 + 没生效，当前窗口却被重置了」。
   *
   * 这里钉住的是「shim 把 VS Code 的 API 形状摆对」这件事：HTML 真的交给宿主、
   * 消息双向通、关面板会触发 onDidDispose（不触发扩展会一直以为它还开着）。
   */
  const setup = () => {
    const htmls: string[] = [];
    const posted: unknown[] = [];
    const uriRequests: string[] = [];
    const revealed: number[] = [];
    const disposed: number[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/x',
      extensionPath: '/tmp/x',
      onCommand: async () => undefined,
      onMessage: () => {},
      onWebviewPanel: () => ({
        panelId: 'panel:demo:1',
        cspSource: 'echoly-webview://ext',
        setHtml: (html: string) => htmls.push(html),
        asWebviewUri: (uri: any) => {
          uriRequests.push(String(uri?.fsPath ?? uri));
          return 'echoly-webview://ext/panel:demo:1/-/abs/AAA';
        },
        postMessage: (message: any) => {
          posted.push(message);
          return true;
        },
        reveal: () => revealed.push(1),
        dispose: () => disposed.push(1),
      }),
    });
    const api = shim.createAPI() as any;
    return { shim, api, htmls, posted, uriRequests, revealed, disposed };
  };

  it('webview.html → 宿主；asWebviewUri / cspSource / postMessage / reveal 都接上', () => {
    const { api, htmls, posted, uriRequests, revealed } = setup();
    const panel = api.window.createWebviewPanel('demo.panel', 'Demo', 1, { enableScripts: true });

    panel.webview.html = '<html>hi</html>';
    expect(htmls).toEqual(['<html>hi</html>']);
    expect(panel.viewType).toBe('demo.panel');
    expect(panel.viewColumn).toBe(1);

    expect(panel.webview.asWebviewUri(api.Uri.file('/tmp/x/webview/index.js'))).toBe(
      'echoly-webview://ext/panel:demo:1/-/abs/AAA',
    );
    expect(uriRequests).toEqual(['/tmp/x/webview/index.js']);
    expect(panel.webview.cspSource).toBe('echoly-webview://ext');

    void panel.webview.postMessage({ hello: 1 });
    expect(posted).toEqual([{ hello: 1 }]);

    panel.reveal();
    expect(revealed).toEqual([1]);
  });

  it('panel.title 的改动会推给宿主（Claude 的会话名是后生成的）', () => {
    const titles: string[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/x',
      extensionPath: '/tmp/x',
      onCommand: async () => undefined,
      onMessage: () => {},
      onWebviewPanel: () => ({
        panelId: 'panel:demo:2',
        cspSource: 'echoly-webview://ext',
        setHtml: () => {},
        asWebviewUri: () => '',
        postMessage: () => true,
        reveal: () => {},
        dispose: () => {},
        setTitle: (title: string) => titles.push(title),
      }),
    });
    const api = shim.createAPI() as any;
    const panel = api.window.createWebviewPanel('demo.panel', 'Claude Code', 1);

    panel.title = 'Fix the resize bug';
    expect(panel.title).toBe('Fix the resize bug');
    expect(titles).toEqual(['Fix the resize bug']);
  });

  it('界面发回来的消息投到 onDidReceiveMessage；摘掉订阅之后不再投', () => {
    const { shim, api } = setup();
    const panel = api.window.createWebviewPanel('demo.panel', 'Demo', 1);
    const seen: unknown[] = [];
    const sub = panel.webview.onDidReceiveMessage((message: any) => seen.push(message));

    expect(shim.deliverPanelMessage('panel:demo:1', { from: 'guest' })).toBe(true);
    expect(seen).toEqual([{ from: 'guest' }]);
    // 不认识的 panelId 要明确说「不是我的」，宿主据此判断没人认领
    expect(shim.deliverPanelMessage('panel:other:9', {})).toBe(false);

    sub.dispose();
    shim.deliverPanelMessage('panel:demo:1', { from: 'guest-2' });
    expect(seen).toEqual([{ from: 'guest' }]);
  });

  it('关面板触发 onDidDispose 并清掉 backend（扩展据此注销会话）', () => {
    const { shim, api, disposed } = setup();
    const panel = api.window.createWebviewPanel('demo.panel', 'Demo', 1);
    let disposedCalls = 0;
    panel.onDidDispose(() => {
      disposedCalls += 1;
    });

    // 宿主侧（渲染层关了标签）调的这条路
    expect(shim.disposePanel('panel:demo:1')).toBe(true);
    expect(disposedCalls).toBe(1);
    expect(disposed).toEqual([1]);
    // 重复关不重复触发
    expect(shim.disposePanel('panel:demo:1')).toBe(false);
    expect(disposedCalls).toBe(1);

    // 扩展自己 dispose 也一样（两次都算，callback 只跑一次）
    const panel2 = api.window.createWebviewPanel('demo.panel', 'Demo', 1);
    let calls2 = 0;
    panel2.onDidDispose(() => {
      calls2 += 1;
    });
    panel2.dispose();
    panel2.dispose();
    expect(calls2).toBe(1);
  });

  it('宿主没实现面板时退回空壳：不抛，扩展的后续代码还能跑', () => {
    const api = createApi();
    const panel = api.window.createWebviewPanel('demo.panel', 'Demo', 1);
    expect(() => {
      panel.webview.html = '<html></html>';
      panel.dispose();
    }).not.toThrow();
  });
});

describe('workspace.getConfiguration 真读真写（以前永远返回调用方给的默认值）', () => {
  /**
   * 这条以前是坏的：`get(key, dflt)` 无条件返回 `dflt` —— 扩展自己 package.json 里
   * 声明的默认值不生效，用户改的值传不进来，`update()` 也是空操作。
   * 对 Claude 那种「读不到就自己兜底」的扩展看不出来，对 Codex 那种三十多个配置项的
   * 扩展就是「怎么调都没反应」。
   */
  const setup = () => {
    const values: Record<string, unknown> = { 'chatgpt.model': 'gpt-5.3-codex' };
    const writes: { key: string; value: unknown }[] = [];
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/x',
      extensionPath: '/tmp/x',
      onCommand: async () => undefined,
      onMessage: () => {},
      services: {
        settings: {
          get: (key) => values[key],
          has: (key) => values[key] !== undefined,
          inspect: (key) => ({ defaultValue: 'fallback', globalValue: values[key] }),
          update: (key, value) => {
            values[key] = value;
            writes.push({ key, value });
          },
        },
      },
    });
    return { api: shim.createAPI() as any, values, writes };
  };

  it('用户值优先，其次才是调用方传的默认值', () => {
    const { api } = setup();
    const chatgpt = api.workspace.getConfiguration('chatgpt');
    expect(chatgpt.get('model')).toBe('gpt-5.3-codex');
    expect(chatgpt.get('model', '想被忽略')).toBe('gpt-5.3-codex');
    // 没设过的项回落到调用方给的默认值，而不是 undefined
    expect(chatgpt.get('approvalMode', 'auto')).toBe('auto');
    expect(chatgpt.has('model')).toBe(true);
    expect(chatgpt.has('nope')).toBe(false);
  });

  it('update 真的写下去，并且回调 onDidChangeConfiguration', async () => {
    const { api, writes } = setup();
    const chatgpt = api.workspace.getConfiguration('chatgpt');
    const affected: string[] = [];
    api.workspace.onDidChangeConfiguration((e: any) => {
      if (e.affectsConfiguration('chatgpt')) affected.push('chatgpt');
      if (e.affectsConfiguration('chatgpt.other')) affected.push('chatgpt.other');
    });

    await chatgpt.update('model', 'gpt-5.4');

    expect(writes).toEqual([{ key: 'chatgpt.model', value: 'gpt-5.4' }]);
    expect(chatgpt.get('model')).toBe('gpt-5.4');
    // 写完不通知的话，扩展「写完之后重读」这一步等于什么都没发生
    expect(affected).toEqual(['chatgpt']);
  });
});

describe('扩展 context 的身份、状态与密钥（以前全是假的）', () => {
  /**
   * 以前 `context.extension.id` 写死 `'unknown.extension'`、`globalState`/`workspaceState`
   * 不落盘、`secrets` 永远 undefined —— 扩展每重启一次就像第一次运行。
   * 这里钉的是「身份和这三个存储真的接上了宿主」。
   */
  const setup = () => {
    const global: Record<string, unknown> = {};
    const workspace: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    const shim = new VSCodeShim({
      workspaceRoot: '/tmp/x',
      extensionPath: '/tmp/x',
      onCommand: async () => undefined,
      onMessage: () => {},
      services: {
        storage: {
          get: (_id, scope, key) => (scope === 'global' ? global : workspace)[key],
          update: (_id, scope, key, value) => {
            const bucket = scope === 'global' ? global : workspace;
            if (value === undefined) delete bucket[key];
            else bucket[key] = value;
          },
          keys: (_id, scope) => Object.keys(scope === 'global' ? global : workspace),
        },
        secrets: {
          get: async (_id, key) => secrets[key],
          store: async (_id, key, value) => {
            secrets[key] = value;
          },
          delete: async (_id, key) => {
            delete secrets[key];
          },
        },
        storagePaths: () => ({
          globalStorage: '/tmp/x/global',
          workspaceStorage: '/tmp/x/ws',
          log: '/tmp/x/log',
        }),
      },
    });
    return { shim, global, workspace, secrets };
  };

  const makeContext = (shim: any) => {
    return createExtensionContext({
      extensionId: 'openai.chatgpt',
      extensionPath: '/tmp/x',
      manifest: { name: 'chatgpt', publisher: 'openai', version: '9.9.9', displayName: 'Codex' },
      storagePaths: {
        globalStorage: '/tmp/x/global',
        workspaceStorage: '/tmp/x/ws',
        log: '/tmp/x/log',
      },
      services: (shim as any).services,
    });
  };

  it('extension.id 是真的 id，存储目录来自宿主而不是扩展自己的目录', () => {
    const { shim } = setup();
    const ctx = makeContext(shim);
    expect(ctx.extension.id).toBe('openai.chatgpt');
    expect(ctx.extension.packageJSON.version).toBe('9.9.9');
    expect(ctx.globalStorageUri.fsPath).toBe('/tmp/x/global');
    expect(ctx.storageUri.fsPath).toBe('/tmp/x/ws');
    // 以前这三个都指向扩展自己的目录，写进去的东西会跟着扩展一起被删
    expect(ctx.globalStorageUri.fsPath).not.toBe('/tmp/x');
  });

  it('存储目录是「按需」建的：真去碰 storageUri 时才建出来', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'echoly-ctx-'));
    try {
      const globalDir = path.join(root, 'global');
      const shim = new VSCodeShim({
        workspaceRoot: '/tmp/x',
        extensionPath: '/tmp/x',
        onCommand: async () => undefined,
        onMessage: () => {},
      });
      const ctx = createExtensionContext({
        extensionId: 'demo.ext',
        extensionPath: '/tmp/x',
        storagePaths: {
          globalStorage: globalDir,
          workspaceStorage: path.join(root, 'ws'),
          log: path.join(root, 'log'),
        },
        services: (shim as any).services,
      });
      // 建目录这件事**不**发生在建 context 的时候（那会和收尾清理撞车）
      expect(existsSync(globalDir)).toBe(false);
      expect(ctx.globalStorageUri.fsPath).toBe(globalDir);
      expect(existsSync(globalDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('globalState / workspaceState 真的存得住，两个作用域互不串', async () => {
    const { shim } = setup();
    const ctx = makeContext(shim);

    await ctx.globalState.update('nuxShown', true);
    await ctx.workspaceState.update('lastFile', 'a.ts');

    expect(ctx.globalState.get('nuxShown')).toBe(true);
    expect(ctx.globalState.get('nuxShown', false)).toBe(true);
    expect(ctx.workspaceState.get('lastFile')).toBe('a.ts');
    // 同名 key 在两个作用域里是两份
    expect(ctx.workspaceState.get('nuxShown')).toBeUndefined();
    expect(ctx.globalState.keys()).toEqual(['nuxShown']);
    expect(ctx.workspaceState.keys()).toEqual(['lastFile']);

    // 存过 false 也要能取回 false（`??` 会把 false 当成「没存过」）
    await ctx.globalState.update('flag', false);
    expect(ctx.globalState.get('flag', true)).toBe(false);

    // update(undefined) 的语义是删除
    await ctx.globalState.update('flag', undefined);
    expect(ctx.globalState.get('flag')).toBeUndefined();
    expect(ctx.globalState.keys()).toEqual(['nuxShown']);
  });

  it('secrets 真的存得住、删得掉', async () => {
    const { shim, secrets } = setup();
    const ctx = makeContext(shim);

    expect(await ctx.secrets.get('token')).toBeUndefined();
    await ctx.secrets.store('token', 'sk-123');
    expect(await ctx.secrets.get('token')).toBe('sk-123');
    expect(secrets).toEqual({ token: 'sk-123' });
    await ctx.secrets.delete('token');
    expect(await ctx.secrets.get('token')).toBeUndefined();
  });
});

/**
 * API 表面完整性：枚举与类。
 *
 * 这一组是 `openai.chatgpt`（Codex）踩出来的，教训不是「少了一个功能」而是
 * **少一个枚举/类 = 整个扩展装不上用不了**：
 *
 * - `out/extension.js` 顶层就写 `dv.ConfigurationTarget.Workspace`，
 *   而 shim 上没有 `ConfigurationTarget` → `Cannot read properties of undefined
 *   (reading 'Workspace')`，主模块**加载**阶段就挂，界面上只有一句
 *   「已安装，但激活失败」，视图列表全空（用户看到的正是「装完了还是这样」）；
 * - 补完枚举后紧接着是 `window.onDidChangeTerminalShellIntegration is not a function`，
 *   同样把 activate() 打断在开头。
 *
 * 所以这里断言的粒度是「整批」而不是「我今天用到的那个」：枚举、类、以及
 * window/workspace 上那一批事件订阅，全部必须存在。
 */
describe('API 表面完整性（缺一个枚举/类 = 整个扩展装不上用不了）', () => {
  it('官方枚举一个都不能少，且取值与官方一致', () => {
    const api = createApi();
    for (const [name, values] of Object.entries(VSCODE_ENUMS)) {
      expect(api[name], `vscode.${name} 缺失`).toBeDefined();
      expect(api[name], `vscode.${name} 取值与官方不一致`).toEqual(values);
    }
  });

  it('ConfigurationTarget 的取值就是 Codex 依赖的那三个（回归点）', () => {
    const api = createApi();
    // 这条以前是崩点：`ConfigurationTarget` 不存在，扩展主模块加载即失败
    expect(api.ConfigurationTarget.Global).toBe(1);
    expect(api.ConfigurationTarget.Workspace).toBe(2);
    expect(api.ConfigurationTarget.WorkspaceFolder).toBe(3);
  });

  it('枚举/类的来源就是 createAPI 的返回值（不是「文件里写了但没接上」）', () => {
    const api = createApi();
    for (const name of Object.keys(VSCODE_ENUMS)) {
      expect(api[name], `vscode.${name} 没接到 createAPI 上`).toBeDefined();
    }
    for (const name of Object.keys(VSCODE_PLACEHOLDER_CLASSES)) {
      expect(typeof api[name], `vscode.${name} 应是可 new 的类`).toBe('function');
      // 占位类也要能当 disposable 用（扩展普遍把它塞进 subscriptions）
      expect(typeof new api[name]().dispose).toBe('function');
    }
    for (const name of Object.keys(VSCODE_ERROR_CLASSES)) {
      expect(typeof api[name], `vscode.${name} 应是错误类`).toBe('function');
      expect(new api[name]()).toBeInstanceOf(Error);
    }
  });

  it('错误类带着官方那套 code 与静态构造器', () => {
    const api = createApi();
    const notFound = api.FileSystemError.FileNotFound(api.Uri.file('/tmp/nope'));
    expect(notFound).toBeInstanceOf(Error);
    expect(notFound.code).toBe('FileNotFound');
    expect(String(notFound.message)).toContain('/tmp/nope');
  });

  it('window 上的事件订阅全都在（Codex 第一件事就是订终端 shell 集成）', () => {
    const api = createApi();
    const events = [
      'onDidChangeTerminalShellIntegration',
      'onDidStartTerminalShellExecution',
      'onDidEndTerminalShellExecution',
      'onDidChangeTerminalState',
      'onDidChangeActiveNotebookEditor',
      'onDidChangeVisibleNotebookEditors',
      'onDidChangeNotebookEditorSelection',
      'onDidChangeNotebookEditorVisibleRanges',
    ];
    for (const name of events) {
      const subscribe = pick(api, `window.${name}`);
      expect(typeof subscribe, `window.${name} 缺失`).toBe('function');
      // 订阅必须返回 disposable：扩展会把它收进 subscriptions，再统一 dispose
      expect(typeof subscribe(() => {}).dispose).toBe('function');
    }
    // 没有 notebook UI，属性要给空值而不是 undefined（undefined 会变成 undefined.xxx）
    expect(api.window.activeNotebookEditor).toBeUndefined();
    expect(api.window.visibleNotebookEditors).toEqual([]);
  });

  it('window / workspace / env 上 Codex 会碰的形状都在', async () => {
    const api = createApi();
    expect(typeof api.window.createQuickPick().show).toBe('function');
    expect(typeof api.window.createInputBox().show).toBe('function');
    expect(typeof api.window.createTextEditorDecorationType({}).dispose).toBe('function');
    expect(await api.workspace.save(api.Uri.file('/tmp/a'))).toBeUndefined();
    expect(api.workspace.notebookDocuments).toEqual([]);
    expect(api.env.isAppPortable).toBe(false);
    expect(typeof api.env.onDidChangeShell).toBe('function');
  });

  it('chat / lm 给形状不给能力（扩展会先探测再用）', async () => {
    const api = createApi();
    // 探测拿到 undefined 时扩展会走完全不同的降级分支，所以这两个命名空间必须在
    expect(api.lm).toBeTruthy();
    await expect(api.lm.selectChatModels()).resolves.toEqual([]);
    expect(typeof api.lm.onDidChangeChatModels).toBe('function');
    expect(typeof api.lm.registerTool({ id: 'x' }).dispose).toBe('function');
    expect(typeof api.chat.registerChatSessionItemProvider({}).dispose).toBe('function');
    expect(typeof api.chat.createChatParticipant('x').dispose).toBe('function');
  });

  it('UIKind 的取值是官方那套（Desktop=1 / Web=2），env.uiKind 与它一致', () => {
    const api = createApi();
    // 以前这里写成 Web=1/Desktop=2，而 env.uiKind 又标成 Desktop，
    // 结果是 UIKind.Web 与 uiKind 相等 —— 扩展会误判成「跑在浏览器里」
    expect(api.UIKind.Desktop).toBe(1);
    expect(api.UIKind.Web).toBe(2);
    expect(api.env.uiKind).toBe(api.UIKind.Desktop);
  });
});
