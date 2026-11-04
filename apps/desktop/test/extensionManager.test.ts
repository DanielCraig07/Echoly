import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ExtensionManager 的「目录名 ≠ 扩展 id」这条规则必须成立 —— 它是禁用 / 卸载 / 打开视图
 * 三件事共同的地基。
 *
 * 真实踩到过：Claude Code 装在 `claude-code/` 下，而宿主按 `${publisher}.${name}` 记它
 * （`Anthropic.claude-code`）。按目录名当 id 用，结果就是「装是装上了，但界面说它没激活、
 * 也没有视图可开」—— 不报错，只是几个按钮永远不出现。
 *
 * 这里用真实临时目录 + 真实文件跑，只把 electron 的两个入口留成假的：
 * 这两个入口一个提供 userData 路径、一个注册 IPC，都不参与被测逻辑。
 */

const hoisted = vi.hoisted(() => ({ userDataRoot: '', fetched: [] as string[] }));
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.userDataRoot },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  // net.fetch 是协议处理器读磁盘文件的方式；这里只记下它请求了哪个文件
  net: {
    fetch: async (url: string) => {
      hoisted.fetched.push(url);
      return new Response(`RESOURCE:${url}`, {
        status: 200,
        headers: { 'content-type': 'application/javascript' },
      });
    },
  },
  protocol: {},
  session: {
    defaultSession: { protocol: { handle: () => {}, unhandle: () => {} } },
    fromPartition: () => ({ protocol: { handle: () => {}, unhandle: () => {} } }),
  },
}));

const { ExtensionManager } = await import('../src/main/extensionManager');

/** 造一个装好的扩展：目录名与 id 分开给，好覆盖「两者不一致」的情况。 */
async function seedExtension(
  extensionsDir: string,
  dir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const target = path.join(extensionsDir, dir, 'extension');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

describe('ExtensionManager：目录名 ≠ 扩展 id', () => {
  let base: string;
  let extensionsDir: string;
  let manager: InstanceType<typeof ExtensionManager>;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'echoly-extmgr-'));
    hoisted.userDataRoot = base;
    extensionsDir = path.join(base, 'extensions');

    // Claude Code 式的目录名（`claude-code`）与它真实的 id（`Anthropic.claude-code`）不一致
    await seedExtension(extensionsDir, 'claude-code', {
      name: 'claude-code',
      publisher: 'Anthropic',
      displayName: 'Claude Code',
      version: '2.0.0',
      contributes: { commands: [{ command: 'claude-code.open', title: 'Open with Claude' }] },
    });
    // 普通的「目录名就是 id」的扩展，保证两类都能正确列出
    await seedExtension(extensionsDir, 'foo.bar', {
      name: 'bar',
      publisher: 'foo',
      displayName: 'Foo Bar',
      version: '1.0.0',
    });
    // 半截安装：有目录、没有 package.json —— 不该被算成已安装
    await mkdir(path.join(extensionsDir, 'half.broken', 'extension'), { recursive: true });

    // 一个**真的会被激活**的扩展：main 里注册命令，manifest 里给标题。
    // 只有它才能验证「命令有没有带上归属、标题有没有从 manifest 取到」这条链路。
    await seedExtension(extensionsDir, 'demo.cmds', {
      name: 'cmds',
      publisher: 'demo',
      displayName: 'Demo Commands',
      version: '3.0.0',
      main: './extension.js',
      contributes: { commands: [{ command: 'demo.cmds.say', title: 'Say Hello' }] },
    });
    await writeFile(
      path.join(extensionsDir, 'demo.cmds', 'extension', 'extension.js'),
      `function activate() {
  const vscode = require('vscode');
  vscode.commands.registerCommand('demo.cmds.say', () => 'hello');
}
module.exports = { activate };
`,
      'utf8',
    );

    // 一个注册 webview 视图的扩展：它用 Uri.joinPath(extensionUri,'webview','index.js')
    // 定位自己的 bundle —— 这正是 Claude Code 的做法，也是以前整套挂掉的地方。
    await seedExtension(extensionsDir, 'demo.view', {
      name: 'view',
      publisher: 'demo',
      displayName: 'Demo View',
      version: '1.0.0',
      main: './extension.js',
      contributes: {
        views: { demoViewContainer: [{ id: 'demo.viewPane', name: 'Demo Pane', type: 'webview' }] },
      },
    });
    await mkdir(path.join(extensionsDir, 'demo.view', 'extension', 'webview'), { recursive: true });
    await writeFile(
      path.join(extensionsDir, 'demo.view', 'extension', 'webview', 'index.js'),
      '/* fake bundle */\n',
      'utf8',
    );
    await writeFile(
      path.join(extensionsDir, 'demo.view', 'extension', 'extension.js'),
      // 注意：这里是写进磁盘的 JS 源码，不要出现反斜杠转义 —— 外层是模板字符串，
      // 反斜杠会先被模板字符串吃掉一层，写出来的文件反而语法错误。
      `function activate(context) {
  const vscode = require('vscode');
  vscode.window.registerWebviewViewProvider('demo.viewPane', {
    resolveWebviewView(view) {
      const bundle = vscode.Uri.joinPath(context.extensionUri, 'webview', 'index.js');
      const scriptUri = view.webview.asWebviewUri(bundle);
      const csp = "default-src 'none'; style-src " + view.webview.cspSource +
        "; script-src 'nonce-abc123';";
      view.webview.html = '<html><head>' +
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
        '</head><body>' +
        '<script id="demo-bundle" nonce="abc123" src="' + scriptUri + '" type="module"></script>' +
        '</body></html>';
      view.webview.onDidReceiveMessage((m) => {
        globalThis.__echolyDemoGot = m;
        // 投递次数也要记：界面重开之后旧回调必须被摘掉，否则一次操作扩展收到 N 遍
        globalThis.__echolyDemoGotCount = (globalThis.__echolyDemoGotCount || 0) + 1;
      });
    },
  });
  context.subscriptions.push({ dispose() {} });
}
module.exports = { activate };
`,
      'utf8',
    );

    // 一个「真的会开 webview 面板」的扩展（`window.createWebviewPanel`）。
    // Claude Code 的「+」（新会话）走的就是这条 —— 以前 shim 里这个 API 是空壳，
    // HTML 被丢掉、标签不出现，而扩展那边已经把会话记成「开在面板里」。
    await seedExtension(extensionsDir, 'demo.panel', {
      name: 'panel',
      publisher: 'demo',
      displayName: 'Demo Panel',
      version: '1.0.0',
      main: './extension.js',
      // 配置项也要真的声明：默认值从 manifest 读，是这一轮补的能力
      contributes: {
        configuration: {
          properties: {
            'demo.panelType.mode': { type: 'string', default: 'fast' },
            'demo.panelType.other': { type: 'string', default: 'keep' },
          },
        },
      },
    });
    await mkdir(path.join(extensionsDir, 'demo.panel', 'extension', 'webview'), {
      recursive: true,
    });
    await writeFile(
      path.join(extensionsDir, 'demo.panel', 'extension', 'webview', 'index.js'),
      '/* fake panel bundle */\n',
      'utf8',
    );
    await writeFile(
      path.join(extensionsDir, 'demo.panel', 'extension', 'extension.js'),
      // 刻意不写反斜杠转义（外层是模板字符串，会被吃掉一层）
      `function activate(context) {
  const vscode = require('vscode');
  const panel = vscode.window.createWebviewPanel('demo.panelType', 'Demo Panel', 1, {
    enableScripts: true,
  });
  const bundle = vscode.Uri.joinPath(context.extensionUri, 'webview', 'index.js');
  const scriptUri = panel.webview.asWebviewUri(bundle);
  panel.webview.html =
    '<html><head></head><body>' +
    '<script id="demo-panel-bundle" nonce="panel9" src="' + scriptUri + '" type="module"></script>' +
    '</body></html>';
  panel.webview.onDidReceiveMessage((m) => {
    globalThis.__echolyPanelGot = m;
  });
  panel.onDidDispose(() => {
    globalThis.__echolyPanelDisposed = true;
  });
  context.subscriptions.push(panel);
}
module.exports = { activate };
`,
      'utf8',
    );

    manager = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    await manager.initialize();
  });

  /**
   * 轮询等待一个条件成立。自动加载是**故意异步**的（不阻塞启动），
   * 而 `active` 在 `loadedExtensions.set` 那一刻就为真 —— 比 activate() 跑完还早，
   * 所以「等激活好了」不能只看 active，要等真正在意的那件事出现。
   * 轮询而不是 sleep 固定时长：慢机器上固定时长会变成随机失败。
   */
  async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`等了 5 秒，${what} 还是没有出现`);
  }

  /** 等到扩展注册好它贡献的命令（注册发生在 activate() 里，比 active 晚）。 */
  async function waitForCommands(id: string, timeoutMs = 5000) {
    void timeoutMs;
    return waitFor(`扩展 ${id} 的命令`, async () => {
      const hit = (await manager.listInstalledExtensions()).find((e) => e.id === id);
      return hit && hit.commands.length > 0 ? hit : undefined;
    });
  }

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('列表用扩展 id，且忽略半截安装的目录', async () => {
    const list = await manager.listInstalledExtensions();
    expect(list.map((e) => e.id)).toEqual([
      'Anthropic.claude-code',
      'demo.cmds',
      'demo.panel',
      'demo.view',
      'foo.bar',
    ]);
    const claude = list.find((e) => e.id === 'Anthropic.claude-code')!;
    expect(claude.displayName).toBe('Claude Code');
    expect(claude.version).toBe('2.0.0');
    expect(claude.enabled).toBe(true);
  });

  it('禁用状态以扩展 id 落盘，重开之后仍然生效', async () => {
    const res = await manager.setExtensionEnabled('Anthropic.claude-code', false);
    expect(res.ok).toBe(true);

    const saved = JSON.parse(await readFile(path.join(base, 'extensions-state.json'), 'utf8')) as {
      disabled: string[];
    };
    // 存 id 而不是目录名：目录名是磁盘布局，换一次布局禁用名单就全失效
    expect(saved.disabled).toEqual(['Anthropic.claude-code']);

    const again = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    await again.initialize();
    const list = await again.listInstalledExtensions();
    expect(list.find((e) => e.id === 'Anthropic.claude-code')?.enabled).toBe(false);
    expect(list.find((e) => e.id === 'foo.bar')?.enabled).toBe(true);
  });

  it('卸载按 id 找到真实目录（claude-code），并一并删掉同名 vsix', async () => {
    await writeFile(path.join(extensionsDir, 'claude-code.vsix'), 'fake', 'utf8');

    const res = await manager.uninstallExtension('Anthropic.claude-code');
    expect(res.ok).toBe(true);
    expect(existsSync(path.join(extensionsDir, 'claude-code'))).toBe(false);
    expect(existsSync(path.join(extensionsDir, 'claude-code.vsix'))).toBe(false);
    // 别的扩展不能被误伤
    expect(existsSync(path.join(extensionsDir, 'foo.bar'))).toBe(true);
    expect((await manager.listInstalledExtensions()).map((e) => e.id)).toEqual([
      'demo.cmds',
      'demo.panel',
      'demo.view',
      'foo.bar',
    ]);
  });

  describe('扩展界面（echoly-webview:// 协议）', () => {
    /**
     * 让视图的 provider 真正跑一遍 resolve，并把 HTML 生成出来。
     *
     * 重试到成功为止：`active` 为真时 activate() 可能还在跑，
     * 这时候 provider 还没注册（「No WebviewView provider registered」）。
     */
    async function resolveDemoView(): Promise<string> {
      return waitFor('视图 provider 注册完成', async () => {
        try {
          return (await (manager as any).resolveWebviewView('demo.viewPane')) as string;
        } catch {
          return undefined;
        }
      });
    }

    it('扩展界面里的资源地址是协议地址，不再是 file://', async () => {
      const html = await resolveDemoView();

      // file:// 加载不了 module script（扩展的 bundle 基本都是），
      // 而且 file:// 路径里的空格是坏的 —— 所以这里必须是自定义协议。
      expect(html).toContain('echoly-webview://ext/demo.viewPane/webview/index.js');
      expect(html).not.toContain('file://');
      expect(manager.getWebviewUrl('demo.viewPane')).toBe(
        'echoly-webview://ext/demo.viewPane/index.html',
      );
    });

    /**
     * 界面重开（切标签 / React 重挂载）之后，旧界面的消息回调必须被摘掉。
     *
     * 实测：主进程日志里一次 `engine_ui_attach` 会打出 6 条、`webview_focused` 5 条 ——
     * 扩展那边每个请求都收到好几份，于是重复 attach、重复建会话，或者把重复的那几次
     * 当成冲突丢掉。表现出来是「点了没反应」这种最难查的样子（比如点「+」不新增会话）。
     */
    it('重新解析视图之后，一条消息只投递一次', async () => {
      await resolveDemoView();
      // 第二次解析 = 界面重开一份
      await (manager as any).resolveWebviewView('demo.viewPane');

      (globalThis as any).__echolyDemoGotCount = 0;
      (manager as any).deliverWebviewMessage('demo.viewPane', { type: 'demo', content: 1 });

      expect((globalThis as any).__echolyDemoGotCount).toBe(1);
    });

    it('扩展的 CSP 用的是我们的 origin（cspSource 不再是一个不对的串）', async () => {
      const html = await resolveDemoView();
      expect(html).toContain('style-src echoly-webview://ext;');
    });

    it('注入的运行时在位，且沿用了扩展自己的 nonce（否则会被它的 CSP 拦掉）', async () => {
      const html = await resolveDemoView();
      expect(html).toContain('__echolyWebviewBridge');
      expect(html).toContain('acquireVsCodeApi');
      expect(html).toMatch(/<script nonce="abc123">\s*\(function\(\)/);
    });

    it('协议处理器：/index.html 回注入后的 HTML，其余路径回磁盘上的文件', async () => {
      const html = await resolveDemoView();
      hoisted.fetched.length = 0;

      const indexResponse = await (manager as any).handleWebviewRequest(
        'echoly-webview://ext/demo.viewPane/index.html',
      );
      expect(indexResponse.status).toBe(200);
      expect(await indexResponse.text()).toBe(html);

      const assetResponse = await (manager as any).handleWebviewRequest(
        'echoly-webview://ext/demo.viewPane/webview/index.js',
      );
      expect(assetResponse.status).toBe(200);
      // 走的是 net.fetch(真实文件)，而不是返回一段假的字符串
      const expectedFile = pathToFileURL(
        path.join(extensionsDir, 'demo.view', 'extension', 'webview', 'index.js'),
      ).toString();
      expect(hoisted.fetched).toEqual([expectedFile]);
    });

    it('协议处理器：穿越路径 403、未知视图 404、不是本协议 400', async () => {
      await resolveDemoView();
      const status = async (url: string) =>
        (await (manager as any).handleWebviewRequest(url)).status;

      // 百分号编码的 `..` 是唯一能穿过 URL 解析的形态（字面 `..` 会被 URL 解析器
      // 直接折叠掉，连视图 id 都对不上）—— 我们自己的守卫必须挡住解码之后的那份。
      expect(await status('echoly-webview://ext/demo.viewPane/%2e%2e%2f%2e%2e%2fetc/passwd')).toBe(
        403,
      );
      // 字面 `..` 被 URL 解析器折叠成另一个视图 id，取不到东西 —— 关键是**不能 200**
      expect(await status('echoly-webview://ext/demo.viewPane/../../../../etc/passwd')).not.toBe(
        200,
      );
      expect(await status('echoly-webview://ext/nobody.view/index.html')).toBe(404);
      expect(await status('https://example.com/x')).toBe(400);
    });

    it('页面里带上了主题样式表（扩展的界面全靠 --vscode-* 上色）', async () => {
      const html = await resolveDemoView();
      expect(html).toContain('/__echoly-theme.css');
    });

    it('主题变量由渲染进程推过来，协议按 CSS 端出去', async () => {
      manager.setWebviewTheme({ 'editor-background': '#123456', 'font-size': '13px' });

      const response = await (manager as any).handleWebviewRequest(
        'echoly-webview://ext/demo.viewPane/__echoly-theme.css',
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/css');
      const css = await response.text();
      expect(css).toContain('--vscode-editor-background:#123456;');
      expect(css).toContain('--vscode-font-size:13px;');
      // 空值绝不能写进去：`--x:;` 会让 var() 整条声明作废
      manager.setWebviewTheme({ 'editor-background': '', 'font-size': '13px' });
      const again = await (
        await (manager as any).handleWebviewRequest(
          'echoly-webview://ext/demo.viewPane/__echoly-theme.css',
        )
      ).text();
      expect(again).not.toContain('--vscode-editor-background');
      expect(again).toContain('--vscode-font-size:13px;');
    });

    it('界面发回的消息能送到扩展的 onDidReceiveMessage', async () => {
      await resolveDemoView();
      delete (globalThis as any).__echolyDemoGot;

      manager.deliverWebviewMessage('demo.viewPane', { type: 'hello', n: 7 });

      // 没有这一半，面板画得出来但点任何东西都没反应
      expect((globalThis as any).__echolyDemoGot).toEqual({ type: 'hello', n: 7 });
    });

    it('扩展停用后，它的视图运行时（HTML / 消息回调）一起被忘掉', async () => {
      await resolveDemoView();
      await manager.setExtensionEnabled('demo.view', false);

      const response = await (manager as any).handleWebviewRequest(
        'echoly-webview://ext/demo.viewPane/index.html',
      );
      expect(response.status).toBe(404);
      delete (globalThis as any).__echolyDemoGot;
      manager.deliverWebviewMessage('demo.viewPane', { type: 'after-disable' });
      expect((globalThis as any).__echolyDemoGot).toBeUndefined();
    });
  });

  describe('扩展配置：默认值来自 manifest，用户值优先，且真的落盘', () => {
    /**
     * 以前 `getConfiguration().get()` 永远返回调用方传进来的默认值 ——
     * manifest 里 `contributes.configuration.properties[].default` 写的默认值
     * 完全没用上，用户改的值也传不进扩展。
     */
    it('取值顺序：用户值 → manifest 默认值 → undefined', async () => {
      const settings = (manager as any).extensionSettings as Record<string, unknown>;
      // demo.panel 的 manifest 里声明了 demo.panelType.mode 的默认值
      expect((manager as any).settingDefaults.get('demo.panelType.mode')).toBe('fast');
      expect((manager as any).settingGet('demo.panelType.mode')).toBe('fast');

      settings['demo.panelType.mode'] = 'slow';
      expect((manager as any).settingGet('demo.panelType.mode')).toBe('slow');

      // 显式写成 false/0 也要能取回来（用 `??` 就会把它当成「没设置」）
      settings['demo.panelType.flag'] = false;
      expect((manager as any).settingGet('demo.panelType.flag')).toBe(false);

      expect((manager as any).settingGet('nobody.nothing')).toBeUndefined();
    });

    it('update 写进文件，重开之后还在', async () => {
      (manager as any).settingUpdate('demo.panelType.mode', 'slow');
      await (manager as any).persistExtensionSettings();

      const saved = JSON.parse(
        await readFile(path.join(base, 'extension-settings.json'), 'utf8'),
      ) as { values: Record<string, unknown> };
      expect(saved.values['demo.panelType.mode']).toBe('slow');

      const again = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
      await again.initialize();
      expect((again as any).settingGet('demo.panelType.mode')).toBe('slow');
      // manifest 里的默认值仍然在（另一项没被覆盖）
      expect((again as any).settingGet('demo.panelType.other')).toBe('keep');
    });
  });

  describe('扩展状态 / 密钥 / 存储目录真的落盘', () => {
    it('globalState / workspaceState 写进文件，重开之后还在', async () => {
      (manager as any).stateUpdate('demo.panel', 'global', 'nuxShown', true);
      (manager as any).stateUpdate('demo.panel', 'workspace', 'lastFile', 'a.ts');
      // 落盘本身是后台跑的（不阻塞扩展），测试里显式等它写完，别靠 sleep
      await (manager as any).persistExtensionState();

      const saved = JSON.parse(
        await readFile(path.join(base, 'extension-state.json'), 'utf8'),
      ) as Record<string, any>;
      expect(saved['demo.panel'].global.nuxShown).toBe(true);
      expect(Object.values(saved['demo.panel'].workspace)[0]).toEqual({ lastFile: 'a.ts' });

      const again = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
      await again.initialize();
      expect((again as any).stateGet('demo.panel', 'global', 'nuxShown')).toBe(true);
      expect((again as any).stateGet('demo.panel', 'workspace', 'lastFile')).toBe('a.ts');
    });

    it('workspaceState 按工作区分开存（同一个扩展在两个项目里是两份）', async () => {
      // 先在工作区 A 里写下两份状态
      (manager as any).stateUpdate('demo.panel', 'global', 'nuxShown', true);
      (manager as any).stateUpdate('demo.panel', 'workspace', 'lastFile', 'a.ts');
      await (manager as any).persistExtensionState();

      // 换一个工作区：workspaceState 是另一份，globalState 还是同一份
      const other = new ExtensionManager({ workspaceRoot: base + '/other', registry: 'x' });
      await other.initialize();
      expect((other as any).stateGet('demo.panel', 'workspace', 'lastFile')).toBeUndefined();
      expect((other as any).stateGet('demo.panel', 'global', 'nuxShown')).toBe(true);

      (other as any).stateUpdate('demo.panel', 'workspace', 'lastFile', 'b.ts');
      await (other as any).persistExtensionState();

      // 第三个工作区：两份 workspaceState 都读不到，globalState 仍然在
      const third = new ExtensionManager({ workspaceRoot: base + '/third', registry: 'x' });
      await third.initialize();
      expect((third as any).stateGet('demo.panel', 'workspace', 'lastFile')).toBeUndefined();
      expect((third as any).stateGet('demo.panel', 'global', 'nuxShown')).toBe(true);
    });

    it('secrets 落盘（系统钥匙串不可用时退明文，但读得回来）', async () => {
      await (manager as any).secretStore('demo.panel', 'token', 'sk-123');
      expect(await (manager as any).secretGet('demo.panel', 'token')).toBe('sk-123');

      const saved = JSON.parse(
        await readFile(path.join(base, 'extension-secrets.json'), 'utf8'),
      ) as Record<string, any>;
      expect(saved['demo.panel'].token.data).toBe('sk-123');

      await (manager as any).secretDelete('demo.panel', 'token');
      expect(await (manager as any).secretGet('demo.panel', 'token')).toBeUndefined();
    });

    it('存储目录在 userData 下按扩展 id 分，不是扩展自己的目录', () => {
      const paths = (manager as any).extensionStoragePaths('demo.panel');
      expect(paths.globalStorage.startsWith(base)).toBe(true);
      expect(paths.globalStorage).toContain('demo.panel');
      expect(paths.workspaceStorage).toContain('workspace');
      // 换一个工作区就是另一个目录（workspaceState 不跨项目）
      const other = new ExtensionManager({ workspaceRoot: base + '/other', registry: 'x' });
      expect((other as any).extensionStoragePaths('demo.panel').globalStorage).toBe(
        paths.globalStorage,
      );
      expect((other as any).extensionStoragePaths('demo.panel').workspaceStorage).not.toBe(
        paths.workspaceStorage,
      );
    });

    it('卸载之后状态与密钥一起清掉（重装不该继承上一次的登录态）', async () => {
      (manager as any).stateUpdate('demo.view', 'global', 'token', 'x');
      await (manager as any).secretStore('demo.view', 'token', 'y');
      await (manager as any).persistExtensionState();
      await (manager as any).persistExtensionSecrets();

      const res = await manager.uninstallExtension('demo.view');
      expect(res.ok).toBe(true);

      const stateFile = JSON.parse(
        await readFile(path.join(base, 'extension-state.json'), 'utf8'),
      ) as Record<string, any>;
      const secretsFile = JSON.parse(
        await readFile(path.join(base, 'extension-secrets.json'), 'utf8'),
      ) as Record<string, any>;
      expect(stateFile['demo.view']).toBeUndefined();
      expect(secretsFile['demo.view']).toBeUndefined();
    });
  });

  describe('贡献的视图：展示名与面板归属', () => {
    /**
     * `views` 以前是 `string[]`，而渲染层一直按 `{id, name}` 读（`ext.views[0].id`）——
     * 于是扩展列表与详情页上的「打开」拿到的是 `undefined`，点下去什么都不会发生。
     */
    it('views 是 {id, name}，名字来自 manifest 的 contributes.views', async () => {
      const viewId = await waitFor('demo.view 的视图注册完成', async () => {
        const hit = (await manager.listInstalledExtensions()).find((e) => e.id === 'demo.view');
        return hit && hit.views.length > 0 ? hit.views[0].id : undefined;
      });
      expect(viewId).toBe('demo.viewPane');

      const hit = (await manager.listInstalledExtensions()).find((e) => e.id === 'demo.view')!;
      expect(hit.views).toEqual([{ id: 'demo.viewPane', name: 'Demo Pane' }]);
    });

    /**
     * 面板归属决定「这个会话标签挂在哪个面板下面」。它没法从 createWebviewPanel 的
     * 参数里看出来，只能靠「刚才这条请求是谁在处理」推 —— 推错的表现是会话跑到
     * 别的扩展的标签行里，或者干脆不显示。
     */
    it('建面板时按「谁在处理这条请求」记归属', () => {
      (manager as any).panelOwnerHint = { id: 'demo.view', at: Date.now() };
      const backend = (manager as any).createExtensionWebviewPanel({
        viewType: 'demo.panelType',
        title: 'Demo Panel',
      });
      backend.setHtml('<html></html>');
      expect((manager as any).webviewPanels.get(backend.panelId)?.ownerExtensionId).toBe(
        'demo.view',
      );
    });

    it('归属提示过期（或压根没有）时不乱认亲戚', () => {
      (manager as any).panelOwnerHint = { id: 'demo.view', at: Date.now() - 60_000 };
      const backend = (manager as any).createExtensionWebviewPanel({
        viewType: 'demo.panelType',
        title: 'Demo Panel',
      });
      expect((manager as any).webviewPanels.get(backend.panelId)?.ownerExtensionId).toBeUndefined();
    });
  });

  it('真激活一个扩展：它的命令带上归属，标题从 manifest 取到', async () => {
    const hit = await waitForCommands('demo.cmds');
    // 归属必须记在扩展 id 名下，否则禁用/卸载时无从摘起
    expect(hit.commands).toEqual([{ command: 'demo.cmds.say', title: 'Say Hello' }]);

    // 命令面板拿到的也是同一份（含标题）
    expect(await manager.listExtensionCommands()).toEqual([
      { command: 'demo.cmds.say', extensionId: 'demo.cmds', title: 'Say Hello' },
    ]);

    // 执行得通，禁用它之后命令就不该再在列表里
    expect(await manager.executeCommand('demo.cmds.say')).toBe('hello');
    await manager.setExtensionEnabled('demo.cmds', false);
    expect((await manager.listExtensionCommands()).map((c) => c.command)).not.toContain(
      'demo.cmds.say',
    );
    const disabled = (await manager.listInstalledExtensions()).find((e) => e.id === 'demo.cmds')!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.commands).toEqual([]);
  });

  it('卸载一个不存在的 id 会明确失败，而不是静默成功', async () => {
    const res = await manager.uninstallExtension('nobody.nothing');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('nobody.nothing');
  });
  describe('扩展 webview 面板（window.createWebviewPanel）', () => {
    /**
     * 面板与「视图」在协议层是一回事（一个 key + 一份 HTML + 一个资源根），
     * 区别只在谁开的：视图是扩展注册 provider、由我们 resolve；面板是扩展自己
     * new 出来、自己把 HTML 塞进来的。Claude Code 的「+」（新会话）走后者 ——
     * 以前这个 API 在 shim 里是空壳，表现是「点 + 没生效，当前窗口却被重置了」。
     */
    async function waitForPanel(): Promise<{ panelId: string; html: string }> {
      return waitFor('扩展把面板开出来', async () => {
        const panels = (manager as any).webviewPanels as Map<string, unknown>;
        const panelId = [...panels.keys()].find((k) => k.startsWith('panel:demo.panelType:'));
        if (!panelId) return undefined;
        const html = (await (manager as any).resolveWebviewView(panelId)) as string;
        return html ? { panelId, html } : undefined;
      });
    }

    it('面板的资源地址走协议（绝对路径形式），HTML 里也注入了运行时', async () => {
      const { panelId, html } = await waitForPanel();

      // 路径里每一段都逐段 encode（panelId 里的 `:` 会变成 %3A），协议处理器再解回来
      const encodedId = encodeURIComponent(panelId);
      // 面板拿不到扩展目录（HTML 是扩展自己拼的），所以资源编成 `-/abs/<base64url>`
      expect(html).toContain(`echoly-webview://ext/${encodedId}/-/abs/`);
      expect(html).not.toContain('file://');
      // 与视图同源：acquireVsCodeApi 必须注入，否则扩展的 bundle 一上来就挂
      expect(html).toContain('acquireVsCodeApi');
      // URL 里的 key 就是 panelId，协议处理器据此找到资源根
      expect(manager.getWebviewUrl(panelId)).toBe(`echoly-webview://ext/${encodedId}/index.html`);
    });

    it('面板的资源能通过协议取到（`-/abs/` 那条前缀被单独放行）', async () => {
      const { panelId } = await waitForPanel();
      hoisted.fetched.length = 0;

      const response = await (manager as any).handleWebviewRequest(
        `echoly-webview://ext/${encodeURIComponent(panelId)}/-/abs/${Buffer.from(
          path.join(extensionsDir, 'demo.panel', 'extension', 'webview', 'index.js'),
          'utf8',
        ).toString('base64url')}`,
      );
      expect(response.status).toBe(200);
      expect(hoisted.fetched).toHaveLength(1);
    });

    it('扩展改面板标题时登记表跟着更新（标签不会永远叫「Claude Code」）', () => {
      const backend = (manager as any).createExtensionWebviewPanel({
        viewType: 'demo.panelType',
        title: 'Claude Code',
      });
      backend.setHtml('<html></html>');
      expect((manager as any).webviewPanels.get(backend.panelId)?.title).toBe('Claude Code');

      backend.setTitle('Fix the resize bug');
      expect((manager as any).webviewPanels.get(backend.panelId)?.title).toBe('Fix the resize bug');
    });

    it('界面发回来的消息投给扩展的 onDidReceiveMessage', async () => {
      const { panelId } = await waitForPanel();
      delete (globalThis as any).__echolyPanelGot;

      manager.deliverWebviewMessage(panelId, { type: 'from-panel', value: 7 });

      expect((globalThis as any).__echolyPanelGot).toEqual({ type: 'from-panel', value: 7 });
    });

    it('关面板（标签被关）会触发扩展的 onDidDispose 并清掉登记', async () => {
      const { panelId } = await waitForPanel();
      delete (globalThis as any).__echolyPanelDisposed;

      expect((manager as any).extensionHost.disposePanel(panelId)).toBe(true);

      // 不触发的话扩展会一直以为「这个会话已经开在某个面板里」，之后点什么都不发生
      expect((globalThis as any).__echolyPanelDisposed).toBe(true);
      expect((manager as any).webviewPanels.has(panelId)).toBe(false);
      expect((manager as any).resourceRoots.has(panelId)).toBe(false);
    });
  });

  describe('Claude 侧栏的「+」按面板语义走', () => {
    /**
     * 扩展用 `openNewInTab`（= 「这个界面是不是编辑器面板」）决定点「+」干什么：
     * 面板模式下发给扩展、开一个新标签；侧栏模式下**就地新建会话**，当前对话被清空。
     * 我们的右侧面板渲染的正是侧栏那份界面，所以要把这个字段改成 true ——
     * 否则用户点「+」看到的就是「没新增会话，当前窗口却被重置了」。
     */
    it('侧栏状态里的 openNewInTab 被改成 true（request / response 两种包装都覆盖）', () => {
      const call = (message: any) =>
        (manager as any).withPanelNewConversation('claudeVSCodeSidebar', message);

      const pushed = {
        type: 'from-extension',
        message: {
          type: 'request',
          requestId: '',
          request: { type: 'update_state', state: { openNewInTab: false, cwd: '/x' } },
        },
      };
      expect(call(pushed).message.request.state).toEqual({ openNewInTab: true, cwd: '/x' });

      const init = {
        type: 'from-extension',
        message: {
          type: 'response',
          requestId: 'r1',
          response: { type: 'init_response', state: { openNewInTab: false } },
        },
      };
      expect(call(init).message.response.state.openNewInTab).toBe(true);
    });

    it('只动这一个字段：别的视图、别的消息原样透传', () => {
      const other = {
        type: 'from-extension',
        message: {
          type: 'request',
          request: { type: 'update_state', state: { openNewInTab: false } },
        },
      };
      // 别的视图不改
      expect((manager as any).withPanelNewConversation('demo.viewPane', other)).toBe(other);
      // 不是状态类的消息不改
      const other2 = {
        type: 'from-extension',
        message: { type: 'request', request: { type: 'something_else' } },
      };
      expect((manager as any).withPanelNewConversation('claudeVSCodeSidebar', other2)).toBe(other2);
      // 已经是 true 的不重复包装（对象要原样返回）
      const already = {
        type: 'from-extension',
        message: {
          type: 'request',
          request: { type: 'update_state', state: { openNewInTab: true } },
        },
      };
      expect((manager as any).withPanelNewConversation('claudeVSCodeSidebar', already)).toBe(
        already,
      );
    });
  });
});
/**
 * 归属 + webview 运行时注入。
 *
 * 这几条都是「Codex 装上之后 Office Viewer 突然失效」这一串问题里挖出来的，
 * 每一条都独立地让扩展「装上了却用不了」：
 *
 * 1. **归属靠一个全局字段**（`activeExtensionId` / `activeExtensionPath`），
 *    而启动时所有扩展是**同时**激活的 —— 字段互相覆盖。实测 Office Viewer 注册的
 *    自定义编辑器归属变成 undefined，于是它的 provider 被算成「不存在」，
 *    `.md` 于是交回内置编辑器；
 * 2. **`hasProvider` 不该看归属**：provider 在不在，和记没记住主人是两件事；
 * 3. **自定义编辑器的 scheme 必须比**：`openai-codex:/**\/*`（Codex 的会话编辑器）
 *    与 `file:/**\/*.md`（Office Viewer 的 markdown）去掉 scheme 后一模一样，
 *    不比就会让 Codex 抢走 `.md`（用户看到的是 `Invalid Codex conversation URI`）；
 * 4. **运行时脚本要按 CSP 选落法**：CSP 只给 origin 白名单（没有 `'unsafe-inline'`
 *    也没有 nonce）时内联脚本会被拦，页面里 `acquireVsCodeApi` 就是 undefined，
 *    扩展的 bundle 一上来就崩（Codex 表现为「could not start its user interface」）。
 */
describe('扩展归属 + webview 运行时注入', () => {
  let base: string;
  let extensionsDir: string;
  let manager: InstanceType<typeof ExtensionManager>;

  /** 无 nonce 的 CSP：`script-src` 只给 origin 白名单 —— Codex 就是这样。 */
  const ORIGIN_ONLY_CSP = "default-src 'none'; script-src echoly-webview://ext;";
  /** 带 nonce 的 CSP —— Claude Code 那一类。 */
  const NONCE_CSP = "default-src 'none'; script-src 'nonce-abc123';";

  /**
   * 注册两个 webview 视图的语句（**只是语句**，不要再套一层 `function activate`）。
   *
   * 之前套了一层，写出来的文件就成了「两层 activate，只闭了一个括号」——
   * 扩展加载直接 SyntaxError，测试里表现为一堆莫名其妙的「provider 没注册」。
   */
  const paneStatements = `
  const mkPane = (id, csp) =>
    vscode.window.registerWebviewViewProvider(id, {
      resolveWebviewView(view) {
        view.webview.html =
          '<!doctype html><html><head>' +
          '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
          '</head><body></body></html>';
      },
    });
  mkPane('demo.aPane', ${JSON.stringify(ORIGIN_ONLY_CSP)});
  mkPane('demo.aNoncePane', ${JSON.stringify(NONCE_CSP)});
`;

  async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await probe();
      if (value !== undefined) return value;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`等了 5 秒，${what} 还是没有出现`);
  }

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'echoly-owner-'));
    hoisted.userDataRoot = base;
    extensionsDir = path.join(base, 'extensions');

    // demo.a：同步注册自定义编辑器 + 两个视图（一个无 nonce、一个有 nonce）
    await seedExtension(extensionsDir, 'demo.a', {
      name: 'a',
      publisher: 'demo',
      displayName: 'Demo A',
      version: '1.0.0',
      main: './extension.js',
      contributes: {
        views: {
          demoAContainer: [
            { id: 'demo.aPane', name: 'A Pane', type: 'webview' },
            { id: 'demo.aNoncePane', name: 'A Nonce Pane', type: 'webview' },
          ],
        },
        customEditors: [
          {
            viewType: 'demo.aEditor',
            displayName: 'Demo A Editor',
            selector: [{ filenamePattern: 'file:/**/*.md' }],
          },
        ],
      },
    });
    await writeFile(
      path.join(extensionsDir, 'demo.a', 'extension', 'extension.js'),
      `function activate(context) {
  const vscode = require('vscode');
  vscode.window.registerCustomEditorProvider('demo.aEditor', {
    resolveCustomTextEditor() {},
  });
${paneStatements}}
module.exports = { activate };
`,
      'utf8',
    );

    // demo.b：声明里带 scheme 限定，且**在 activate 的异步尾巴里**才注册 provider
    await seedExtension(extensionsDir, 'demo.b', {
      name: 'b',
      publisher: 'demo',
      displayName: 'Demo B',
      version: '1.0.0',
      main: './extension.js',
      contributes: {
        customEditors: [
          {
            viewType: 'demo.bEditor',
            displayName: 'Demo B Editor',
            selector: [{ filenamePattern: 'demo-b:/**/*' }],
          },
        ],
      },
    });
    await writeFile(
      path.join(extensionsDir, 'demo.b', 'extension', 'extension.js'),
      `function activate(context) {
  const vscode = require('vscode');
  // 故意晚一拍：注册时「谁在激活」那个字段已经清空了
  setTimeout(() => {
    vscode.window.registerCustomEditorProvider('demo.bEditor', { resolveCustomEditor() {} });
  }, 0);
}
module.exports = { activate };
`,
      'utf8',
    );

    manager = new ExtensionManager({ workspaceRoot: base, registry: 'https://open-vsx.org' });
    await manager.initialize();
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('同步注册的 provider 归属是对的（并发激活时会串到别的扩展）', async () => {
    const owner = await waitFor('demo.aEditor 的 provider', async () => {
      const hit = (manager as any).extensionHost
        .listCustomEditorProviders()
        .find((e: any) => e.viewType === 'demo.aEditor');
      return hit ? hit : undefined;
    });
    expect(owner.extensionId).toBe('demo.a');
  });

  it('hasProvider 只看 provider 在不在，与「记没记住主人」无关', async () => {
    const byViewType = await waitFor('demo.bEditor 的 provider', async () => {
      const list = await manager.listCustomEditors();
      return list.find((c) => c.viewType === 'demo.bEditor')?.hasProvider ? list : undefined;
    });
    // demo.b 是在异步尾巴里注册的 → 归属记不下来，但它确实注册上了
    expect(byViewType.find((c) => c.viewType === 'demo.aEditor')!.hasProvider).toBe(true);
    expect(
      (manager as any).extensionHost
        .listCustomEditorProviders()
        .find((e: any) => e.viewType === 'demo.bEditor')?.extensionId,
    ).toBeUndefined();
  });

  it('scheme 限定的 selector 不会来抢 file: 的真实文件', async () => {
    const mdPath = path.join(base, 'note.md');
    await writeFile(mdPath, '# hi\n', 'utf8');
    await waitFor('两个 provider 都注册好', async () =>
      (await manager.listCustomEditors()).every((c) => c.hasProvider) ? true : undefined,
    );
    const picked = await manager.matchCustomEditor(mdPath);
    // `demo-b:/**/*` 与 `file:/**/*.md` 去掉 scheme 后一模一样，只有比 scheme 才分得开
    expect(picked?.viewType).toBe('demo.aEditor');
  });

  it('CSP 只给 origin 白名单时，运行时脚本走外部文件（内联会被拦）', async () => {
    const html = await waitFor('demo.aPane 的 provider', async () => {
      try {
        return await manager.resolveWebviewView('demo.aPane');
      } catch {
        return undefined;
      }
    });
    expect(html).toContain('src="echoly-webview://ext/demo.aPane/__echoly-runtime.js"');
    expect(html).not.toContain('window.acquireVsCodeApi = function');
  });

  it('有 nonce 的 CSP 仍旧走内联，并且带上同一个 nonce', async () => {
    const html = await waitFor('demo.aNoncePane 的 provider', async () => {
      try {
        return await manager.resolveWebviewView('demo.aNoncePane');
      } catch {
        return undefined;
      }
    });
    expect(html).toContain('window.acquireVsCodeApi = function');
    expect(html).toContain('nonce="abc123"');
    expect(html).not.toContain('__echoly-runtime.js');
  });

  it('运行时脚本本身能从协议里取到（否则外部引用就是 404）', async () => {
    const res: Response = await (manager as any).handleWebviewRequest(
      'echoly-webview://ext/demo.aPane/__echoly-runtime.js',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('acquireVsCodeApi');
  });
});
