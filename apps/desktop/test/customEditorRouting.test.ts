import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  compileFilenamePattern,
  isDefaultPriority,
  matchesContribution,
  pickCustomEditor,
  type CustomEditorCandidate,
} from '../src/main/customEditors';

/**
 * 自定义编辑器（`contributes.customEditors`）—— 「装了 Office Viewer，打开 .md 却还是
 * 内置编辑器」这条问题的回归测试。
 *
 * 分两层：
 * - 纯逻辑（glob 匹配、优先级）直接测函数，快且和 electron 无关；
 * - 端到端用一个**真的会激活**的假扩展，走完
 *   「文件 → 认领 → 建面板 → 扩展给 HTML → 资源地址 → 保存落盘」整条链。
 *   这条链上任何一环断掉，用户看到的都是同一句话：「插件没作用于这个文件」。
 */

describe('customEditors：谁接管这个文件', () => {
  const candidate = (
    over: Partial<CustomEditorCandidate> & Pick<CustomEditorCandidate, 'viewType'>,
  ): CustomEditorCandidate => ({
    extensionId: 'demo.ext',
    hasProvider: true,
    patterns: ['*.md'],
    ...over,
  });

  it('纯扩展名能匹配任意层级，且大小写不敏感', () => {
    const md = candidate({ viewType: 'a' });
    expect(matchesContribution(md, 'note.md')).toBe(true);
    expect(matchesContribution(md, 'docs/deep/note.md')).toBe(true);
    expect(matchesContribution(md, 'note.MD')).toBe(true);
    expect(matchesContribution(md, 'note.markdown')).toBe(false);
  });

  it('带 scheme 的 glob：`file:/**/*.md` 要能匹配根目录下的文件', () => {
    // Office Viewer 的 markdownViewer 写的就是这一条
    const compiled = compileFilenamePattern('file:/**/*.md');
    expect(compiled).not.toBeNull();
    // `**/` 必须允许零层目录，否则工作区根目录下的 a.md 永远匹配不上
    expect(compiled!.test('a.md')).toBe(true);
    expect(compiled!.test('docs/a.md')).toBe(true);
  });

  it('多段后缀（`*.tar.gz`）按整段比，不能被 `*.gz` 抢走', () => {
    const tarGz = compileFilenamePattern('*.tar.gz')!;
    expect(tarGz.test('pkg.tar.gz')).toBe(true);
    expect(tarGz.test('pkg.gz')).toBe(false);
  });

  it('不认识的写法返回 null —— 宁可少匹配，也不要用半吊子正则抢文件', () => {
    expect(compileFilenamePattern('*.{md,txt}')).toBeNull();
    expect(compileFilenamePattern('*.[md]')).toBeNull();
    expect(compileFilenamePattern('')).toBeNull();
  });

  it('`option` 优先级不主动抢文件（图片/HTML 预览属于这一类）', () => {
    const option = candidate({ viewType: 'img', priority: 'option', patterns: ['*.png'] });
    expect(isDefaultPriority(option)).toBe(false);
    // pickCustomEditor 本身不排 option —— 「不抢」是在调用方按 isDefaultPriority 过滤的
    expect(pickCustomEditor([option], 'a.png')?.viewType).toBe('img');
  });

  it('default 优先于 option；同样优先级下优先选出真的注册了 provider 的', () => {
    const picked = pickCustomEditor(
      [
        candidate({ viewType: 'option', priority: 'option' }),
        candidate({ viewType: 'default-no-provider', hasProvider: false }),
        candidate({ viewType: 'default-with-provider' }),
      ],
      'a.md',
    );
    expect(picked?.viewType).toBe('default-with-provider');
  });

  it('没人认领就返回 null（交回内置编辑器）', () => {
    expect(pickCustomEditor([candidate({ viewType: 'a' })], 'a.txt')).toBeNull();
  });
});

// ── 端到端：拿真扩展宿主跑一个假扩展 ─────────────────────────────────────────

const hoisted = vi.hoisted(() => ({ userDataRoot: '', handledChannels: [] as string[] }));
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.userDataRoot },
  ipcMain: {
    handle: (channel: string) => {
      hoisted.handledChannels.push(channel);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: async () => new Response('RESOURCE', { status: 200 }) },
  protocol: {},
  session: {
    defaultSession: { protocol: { handle: () => {}, unhandle: () => {} } },
    fromPartition: () => ({ protocol: { handle: () => {}, unhandle: () => {} } }),
  },
}));

const { ExtensionManager } = await import('../src/main/extensionManager');

/**
 * 一个假扩展，但走的是**真**注册路径。
 *
 * 里面刻意保留了 Office Viewer 会把 shim 逼到极限的那几处写法：
 * - `document.uri.with({ query: '', fragment: '' })`（以前 shim 的 Uri 没有 with，
 *   异常还落在没人 await 的 async 链上，界面上只表现为「打不开」）；
 * - `Uri.joinPath(extensionUri, 'webview', 'index.js')` + `asWebviewUri`；
 * - 保存走 `new WorkspaceEdit().replace(uri, new Range(0,0,lineCount,0), text)`
 *   再 `workspace.applyEdit`（以前 applyEdit 无条件返回 true，改动被静默丢掉）。
 */
const FAKE_EXTENSION_JS = `function activate(context) {
  const vscode = require('vscode');
  const state = {};
  globalThis.__demoEditor = state;

  vscode.window.registerCustomEditorProvider('demo.mdViewer', {
    resolveCustomTextEditor(document, panel) {
      state.document = document;
      state.panel = panel;
      // 回归点：没有 with() 的话这里就断了
      state.cacheKey = document.uri.with({ query: '', fragment: '' }).toString();
      const bundle = vscode.Uri.joinPath(context.extensionUri, 'webview', 'index.js');
      panel.webview.html =
        '<html><body data-key="' + state.cacheKey + '" data-text="' +
        document.getText().trim() + '">' +
        '<script src="' + panel.webview.asWebviewUri(bundle) + '"></script>' +
        '</body></html>';
      panel.onDidDispose(() => { state.disposed = true; });
    },
  });

  // 保存：走 WorkspaceEdit → workspace.applyEdit → 宿主落盘
  vscode.commands.registerCommand('demo.mdViewer.save', async (text) => {
    const doc = state.document;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
    return await vscode.workspace.applyEdit(edit);
  });

  vscode.commands.registerCommand('demo.mdViewer.broadcast', () => {
    state.panel.webview.postMessage({ type: 'ping', content: 1 });
    return 'sent';
  });
}
module.exports = { activate };
`;

describe('自定义编辑器端到端（假扩展 + 真宿主）', () => {
  let base: string;
  let manager: InstanceType<typeof ExtensionManager>;
  let mdPath: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'echoly-customeditor-'));
    hoisted.userDataRoot = base;

    const extDir = path.join(base, 'extensions', 'demo.editor', 'extension');
    await mkdir(path.join(extDir, 'webview'), { recursive: true });
    await writeFile(
      path.join(extDir, 'package.json'),
      JSON.stringify({
        name: 'editor',
        publisher: 'demo',
        displayName: 'Demo Editor',
        version: '1.0.0',
        main: './extension.js',
        contributes: {
          customEditors: [
            {
              viewType: 'demo.mdViewer',
              displayName: 'Demo Markdown',
              selector: [{ filenamePattern: '*.md' }],
            },
          ],
        },
      }),
      'utf8',
    );
    await writeFile(path.join(extDir, 'extension.js'), FAKE_EXTENSION_JS, 'utf8');
    await writeFile(path.join(extDir, 'webview', 'index.js'), '/* bundle */\n', 'utf8');

    mdPath = path.join(base, 'note.md');
    await writeFile(mdPath, '# Hello\n', 'utf8');

    manager = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    await manager.initialize();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  /** 激活是故意异步的：等到 provider 真的注册上为止。 */
  async function waitForProvider(): Promise<string> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const match = await manager.matchCustomEditor(mdPath);
      if (match) return match.viewType;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('等了 5 秒，扩展还是没有注册 custom editor provider');
  }

  it('.md 被扩展认领，并且真的拿到了扩展给出的界面', async () => {
    expect(await waitForProvider()).toBe('demo.mdViewer');

    const opened = await manager.openCustomEditor(mdPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const html = (manager as any).webviewHtml.get(opened.panelKey) as string;
    // 界面里出现了文件内容（扩展真的读到了 document）
    expect(html).toContain('# Hello');
    // 资源地址走的是我们的协议，不是 file://（file:// 加载不了 module script）
    expect(html).toContain('echoly-webview://ext/');
    expect(html).not.toContain('file://');
    // Uri.with 那一步没抛（拿到 cacheKey 才说明跑过去了）
    expect(html).toContain('data-key="/');
  });

  it('扩展把界面里的资源请求落到扩展目录里（协议 200）', async () => {
    await waitForProvider();
    const opened = await manager.openCustomEditor(mdPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const index = await (manager as any).handleWebviewRequest(opened.url);
    expect(index.status).toBe(200);
    const bundle = await (manager as any).handleWebviewRequest(
      `echoly-webview://ext/${encodeURIComponent(opened.panelKey)}/webview/index.js`,
    );
    expect(bundle.status).toBe(200);
  });

  it('导出不去碰扩展目录之外的文件', async () => {
    await waitForProvider();
    const opened = await manager.openCustomEditor(mdPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const escaped = await (manager as any).handleWebviewRequest(
      `echoly-webview://ext/${encodeURIComponent(opened.panelKey)}/../../../etc/passwd`,
    );
    expect(escaped.status).not.toBe(200);
  });

  it('保存：WorkspaceEdit 真的写进磁盘，不是假装成功', async () => {
    await waitForProvider();
    const opened = await manager.openCustomEditor(mdPath);
    expect(opened.ok).toBe(true);

    const result = await (manager as any).extensionHost.executeCommand(
      'demo.mdViewer.save',
      '# Edited\n',
    );
    expect(result).toBe(true);
    expect(await readFile(mdPath, 'utf8')).toBe('# Edited\n');
  });

  it('关掉标签会释放面板（扩展的 onDidDispose 要跑）', async () => {
    await waitForProvider();
    const opened = await manager.openCustomEditor(mdPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    manager.disposeCustomEditor(opened.panelKey);
    expect((globalThis as any).__demoEditor.disposed).toBe(true);
  });

  /**
   * 启动竞态：扩展是异步加载的，而「打开文件」可能比它先到。
   *
   * 会话恢复（重开应用时还原上次打开的文件）正好落在这个窗口里 —— 判错的表现就是
   * 「装了 Office Viewer，重开应用后 .md 又是内置编辑器了」，而用户完全无从判断
   * 这是竞态。这条**刻意不等** provider 注册，直接问。
   */
  it('扩展还没注册完就问也不许判「没人认领」', async () => {
    const matched = await manager.matchCustomEditor(mdPath);
    expect(matched?.viewType).toBe('demo.mdViewer');
  });

  /**
   * 处理器必须在**构造完成时**就注册好。
   *
   * 踩过一次：主进程「窗口先起来、扩展管理器延迟 2 秒初始化」，而渲染层一挂载就会
   * 问扩展的事（会话恢复问「这个文件归谁」、启动时推主题变量、拉命令列表）。
   * 那 2 秒里这些 invoke 全部落到 `No handler registered`（主进程日志里有一排），
   * 后果不是「晚两秒生效」而是**又静默又持久**：会话恢复问不到答案，`.md` 被当成
   * 普通文本恢复，之后点它只是切前台 —— 用户看到的是「装了 Office Viewer 却一直
   * 不生效」。所以这条钉的是「构造完就有处理器」，不是「initialize 之后有」。
   */
  it('构造完成时扩展的 IPC 处理器已经注册好了（不必等 initialize）', () => {
    hoisted.handledChannels.length = 0;
    const fresh = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    void fresh.initialize();
    expect(hoisted.handledChannels).toContain('extension:custom-editor-match');
    expect(hoisted.handledChannels).toContain('extension:set-webview-theme');
    expect(hoisted.handledChannels).toContain('extension:get-loaded');
  });

  it('没有扩展认领的文件直接返回 null（交回内置编辑器）', async () => {
    await waitForProvider();
    expect(await manager.matchCustomEditor(path.join(base, 'note.txt'))).toBeNull();
  });

  it('停用扩展之后不再认领文件（不然会点出一个打不开的标签）', async () => {
    await waitForProvider();
    await manager.setExtensionEnabled('demo.editor', false);
    expect(await manager.matchCustomEditor(mdPath)).toBeNull();
  });
});
