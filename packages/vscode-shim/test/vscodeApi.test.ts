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
      'Uri.file',
      'EventEmitter',
      'Disposable',
    ];
    const missing = required.filter((path) => typeof pick(api, path) !== 'function');
    expect(missing).toEqual([]);
  });

  it('白名单外的命名空间不直接抛错（扩展会访问到，缺了就是崩在 activate 里）', () => {
    expect(VSCODE_API_WHITELIST.has('window')).toBe(true);
    expect(VSCODE_API_WHITELIST.has('debug')).toBe(false);
    const api = createApi();
    // 未列白名单的命名空间要走 stub 而不是 undefined，否则 `vscode.debug.x` 直接 TypeError
    expect(api.debug).toBeTruthy();
  });
});
