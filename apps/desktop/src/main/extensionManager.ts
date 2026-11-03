/**
 * Extension Manager for Electron Main Process
 * 管理 VSCode 扩展的加载、激活和通信
 */

import { BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { EXTENSION_WEBVIEW_PARTITION } from '@deepseek-ide/shared';
import * as path from 'path';
import * as fs from 'fs/promises';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import {
  EXTENSION_WEBVIEW_SCHEME,
  WEBVIEW_INDEX_PATH,
  WEBVIEW_THEME_PATH,
  buildWebviewOrigin,
  buildWebviewUrl,
  extractFsPath,
  parseWebviewRequest,
  resolveWebviewFilePath,
  toAbsWebviewResourcePath,
  toWebviewResourcePath,
} from './extensionWebview';
import { ExtensionHost } from '@deepseek-ide/vscode-shim/src/extensionHost';
import { ShimUri } from '@deepseek-ide/vscode-shim/src/uri';
import {
  loadExtension,
  loadExtensionFromVsix,
  downloadClaudeCodeExtension,
  downloadVsix,
} from '@deepseek-ide/vscode-shim/src/extensionLoader';
import {
  DEFAULT_RECOMMENDED_SIZE,
  MAX_MARKETPLACE_PAGE_SIZE,
  buildDetailUrl,
  buildReadmeCandidates,
  buildRecommendedUrl,
  buildSearchUrl,
  decidePlatformDownload,
  isAllowedIconUrl,
  isPlatformAgnosticDownload,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxDetail,
  parseOpenVsxSearch,
  parseTargetPlatform,
  splitExtensionId,
  type MarketplaceDetail,
  type MarketplaceExtension,
} from '@deepseek-ide/vscode-shim/src/openVsx';
import { writeVscodeShimModule } from '@deepseek-ide/vscode-shim/src/vscodeShimModule';
import {
  isDefaultPriority,
  matchesContribution,
  pickCustomEditor,
  type CustomEditorCandidate,
  type CustomEditorContribution,
} from './customEditors';
import {
  ICON_CACHE_LIMIT,
  ICON_FETCH_TIMEOUT_MS,
  MAX_ICON_BYTES,
  toIconDataUrl,
} from './extensionIcons';

/**
 * 下载进度的广播载荷。
 *
 * 比 `downloadVsix` 自己给的进度多了**身份**与**结束标记**：
 * - `id`/`name`：面板里可以同时装几个扩展，不带身份的一条「正在下载…」说明不了任何事；
 * - `done`：下载结束（成功或失败）后必须发一条，否则失败时那条进度条会一直挂在那里。
 */
export interface DownloadProgressPayload {
  id: string;
  name: string;
  percent: number;
  downloaded: number;
  total: number;
  done?: boolean;
}

/** Claude Code 的 id 与展示名（专用安装通道的进度也要能显示名字）。 */
const CLAUDE_CODE_ID = 'Anthropic.claude-code';
const CLAUDE_CODE_NAME = 'Claude Code';

/**
 * Claude Code 侧栏视图的 id（右侧 AI 面板里那一栏渲染的就是它）。
 *
 * 单独拿出来是因为下面要按它改写一条状态（见 `withPanelNewConversation`）。
 */
const CLAUDE_CODE_VIEW_ID = 'claudeVSCodeSidebar';

/**
 * 行列位置 → 字符偏移（按 `\n` 切）。
 *
 * 落盘 `WorkspaceEdit` 时要按偏移切片。列号会被夹到该行长度内 ——
 * 扩展给的 `Range(0,0,lineCount,0)` 里那个 0 是「最后一行的行首」，是合法位置；
 * 而个别扩展会给出行长之外的列号，夹一下比抛异常合理。
 */
function offsetOf(text: string, position: { line: number; character: number }): number {
  const lines = text.split('\n');
  const line = Math.max(0, Math.min(position.line, lines.length));
  let offset = 0;
  for (let i = 0; i < line; i += 1) offset += lines[i].length + 1;
  const character = Math.max(0, Math.min(position.character, lines[line]?.length ?? 0));
  return Math.min(offset + character, text.length);
}

/**
 * 等扩展设置 `webview.html` 的上限。
 *
 * 2 秒是个折中：扩展一般是同步赋值或本地读一个模板文件（毫秒级），2 秒足够；
 * 再长就会让「打开文件」这件事明显卡住，而那种情况下多半是真的失败了。
 */
const CUSTOM_EDITOR_HTML_WAIT_MS = 2000;

/**
 * 等「启动时那批扩展加载完」的上限。
 *
 * 只在「有扩展声明认这个文件、但 provider 还没注册」时才会等，所以正常路径上
 * 一次都不会触发。上限的作用是兜底：真有扩展卡住，也不该把「打开文件」一起拖住。
 */
const INITIAL_ACTIVATION_WAIT_MS = 5000;

/**
 * 官方的 `filters` 是 `{ Images: ['png','jpg'], Text: ['txt'] }`，
 * electron 要的是 `[{ name: 'Images', extensions: ['png'] }]`。
 *
 * 翻错的表现不是报错，而是「对话框里什么都选不了」——那种最难查。
 * 扩展名去掉前导点（官方两种写法都有）。
 */
/**
 * 一条 webview → 扩展的消息「叫什么」。
 *
 * 扩展习惯包一层（`{type:'from-webview', content:{…}}` 或
 * `{type:'request', request:{type:'newSession'}}`），所以里外都看一眼 ——
 * 只看外层永远只能看到 `request` 这一种，等于没记。
 */
function describeWebviewMessage(message: any): string {
  const outer = typeof message?.type === 'string' ? message.type : typeof message;
  const inner =
    typeof message?.request?.type === 'string'
      ? `/${message.request.type}`
      : typeof message?.content?.type === 'string'
        ? `/${message.content.type}`
        : '';
  return `${outer}${inner}`;
}

function toElectronFilters(filters: any): { name: string; extensions: string[] }[] {
  if (!filters || typeof filters !== 'object') return [];
  return Object.entries(filters)
    .map(([name, exts]) => ({
      name,
      extensions: Array.isArray(exts) ? exts.map((e: any) => String(e).replace(/^\./, '')) : [],
    }))
    .filter((entry) => entry.extensions.length > 0);
}

/** 协议处理里的纯文本响应头（错误信息要能直接看出来，不是一坨 HTML）。 */
const TEXT_PLAIN_HEADERS = { 'content-type': 'text/plain; charset=utf-8' } as const;

/** README 抓取上限：详情页是展示用的，没必要为一个说明文件拉几百 KB。 */
const maxReadmeBytes = 512 * 1024;
const maxReadmeChars = 200_000;
const readmeFetchTimeoutMs = 10_000;

/**
 * 磁盘上的一条已安装扩展记录。
 *
 * 分开存 `dir` 与 `id` 是有原因的：**目录名不等于扩展 id**。Claude Code 装在
 * `claude-code/` 下，但它的 id 由 package.json 决定（`Anthropic.claude-code`）。
 * 宿主按 `${publisher}.${name}` 记扩展 —— 命令/视图的归属、`getLoadedExtensions`
 * 也全是这个 id；而路径操作（读文件、删目录）用的必须是目录名。两边混用会得到
 * 「装是装上了，但界面说它没激活、也没有视图可开」这种最难查的毛病。
 */
interface InstalledRecord {
  /** 扩展目录名（文件路径用） */
  dir: string;
  /** 扩展 id：优先 manifest 的 `publisher.name`，缺了才退回目录名 */
  id: string;
  manifest: any;
}

/** 管理界面要的一条「已安装扩展」。 */
export interface InstalledExtensionInfo {
  /** `publisher.name`（扩展 id）。**注意它不一定是磁盘目录名**，见 InstalledRecord */
  id: string;
  displayName: string;
  version?: string;
  /** 用户有没有禁用它 */
  enabled: boolean;
  /** 此刻是否已经加载并激活 */
  active: boolean;
  /** 它注册的命令（带人类可读标题，供详情页直接列出来运行） */
  commands: { command: string; title: string }[];
  /** 它注册的 webview 视图 id 列表（非空才有「打开视图」可点） */
  views: string[];
}

export interface ExtensionManagerOptions {
  workspaceRoot: string;
  onMessage?: (message: any) => void;
  /** Open VSX 注册表地址。默认官方站；企业内网可以指向自建镜像。 */
  registry?: string;
}

export class ExtensionManager {
  private extensionHost: ExtensionHost;
  private extensionsDir: string;
  private workspaceRoot: string;
  private messageHandlers: Set<(message: any) => void> = new Set();
  private loadedExtensionPaths: Set<string> = new Set();
  private webviewViewProviders: Map<string, any> = new Map();
  /**
   * viewId → 注册它的扩展 id。
   *
   * 卸载/禁用时要按它把视图一起摘掉：扩展已经不在磁盘上了（或已被停用），
   * 留着 provider 只会让面板里那个标签打开一片空白。
   */
  private viewOwners: Map<string, string> = new Map();
  /**
   * 被用户禁用的扩展 id（持久化）。
   *
   * 存在 userData 而不是扩展目录里：卸载是「删目录」，而禁用必须挺过重启 ——
   * 把状态文件放进 extensionsDir 会让目录扫描把它当成一个扩展。
   */
  private disabledExtensions: Set<string> = new Set();
  private readonly registry: string;
  /**
   * 图标 data URL 缓存。
   *
   * 列表每次重渲染都会问一遍图标，不缓存就是每次翻页都重新抓几十张图。
   * 缓存的是**结果**（含 null）：抓失败的图标不该每次滚动都重试一遍。
   */
  private readonly iconCache = new Map<string, string | null>();
  /** vscode shim 写盘的一次性任务，见 ensureVscodeShim */
  private vscodeShimReady: Promise<void> | null = null;
  /**
   * viewId → 该视图的初始 HTML。
   *
   * 协议处理器按 `/<viewId>/index.html` 从这里取。不复用磁盘文件（以前那版写
   * `webview-<viewId>.html`）是因为 `file://` 页面加载不了 module script，
   * 而扩展的 bundle 几乎全是 `<script type="module">`（详见 extensionWebview.ts）。
   */
  private webviewHtml = new Map<string, string>();
  /**
   * viewId → 扩展注册的 `onDidReceiveMessage` 回调。
   *
   * 没有它，用户在这个界面里点任何东西都石沉大海 —— 面板能画出来但完全不能用。
   */
  private webviewMessageHandlers = new Map<string, Set<(message: any) => void>>();
  /** `<webview>` 的访客 preload（`file://` URL）。渲染进程不知道主进程的目录布局，由这里给。 */
  private webviewPreloadUrl = '';
  /**
   * 注入给扩展界面的 `--vscode-*` 变量（渲染进程算好之后推过来）。
   *
   * 为什么不在这里自己算：颜色要跟着**当前主题**走（应用有暗/亮两套），而主题是
   * 渲染进程的状态 —— 它读 `:root` 上的实际值最准，主进程只能猜。
   * 渲染进程启动时推一次、切主题时再推一次。
   */
  private webviewThemeVars: Record<string, string> = {};
  /**
   * 「协议里的 key」→ 它的资源根目录。
   *
   * webview 视图与自定义编辑器面板是两套东西，但对协议处理器来说是一样的：
   * 给定一个 key，去某个扩展目录里取文件。以前处理器直接查 `webviewViewProviders`，
   * 加了自定义编辑器之后就必须有这张独立的表，否则后者的资源一个都取不到。
   */
  private resourceRoots = new Map<string, string>();
  /**
   * 已开出去的 webview 面板（`window.createWebviewPanel`）：panelId → 元信息。
   *
   * 「面板」和「视图」在协议层是一回事（一个 key + 一份 HTML + 一个资源根），
   * 区别只在谁开的：视图是扩展注册 provider 由我们 resolve，面板是扩展自己
   * new 出来、自己把 HTML 塞进来的（Claude 的「+」新会话就是后者）。
   */
  private webviewPanels = new Map<string, { title: string; viewType: string }>();
  /** 面板 id 的自增序号（`panel:<viewType>:<n>`，同一 viewType 可以开多个）。 */
  private panelSeq = 0;
  /**
   * 面板的资源根目录**哨兵**。
   *
   * 面板拿不到扩展目录（HTML 在扩展代码里拼，`asWebviewUri` 只给绝对路径），
   * 所以面板的资源一律编成 `-/abs/<base64url>`；协议处理器对这条前缀直接放行。
   * 这里塞一个**不存在**的目录当根：万一有人用相对路径请求面板资源，
   * 归一化之后会落在它下面、`fs.access` 自然失败 —— 不会变成「能读本机任意文件」。
   */
  private static readonly PANEL_ROOT_SENTINEL = '/__echoly-webview-panel__';
  /**
   * 已打开的自定义编辑器面板：panelKey → 运行时。
   *
   * key 用 `editor:<序号>` 而不是 viewType：同一个 viewType 可以对多个文件各开一个
   * 面板（两个 .md 并排），HTML 是按**文件**生成的，不能按 viewType 缓存。
   */
  private customEditorPanels = new Map<
    string,
    {
      viewType: string;
      extensionId?: string;
      filePath: string;
      messageHandlers: Set<(message: any) => void>;
      onDispose: Set<() => void>;
    }
  >();
  private customEditorSeq = 0;
  /**
   * 启动时那批自动加载的扩展，全部尘埃落定的那一刻。
   *
   * 扩展是**异步**加载的（不阻塞启动），而「这个文件该不该交给扩展」要等扩展注册好
   * provider 才有答案 —— 两者撞在一起的结果是：应用刚起来那几秒里打开 .md，
   * 明明装了 Office Viewer 也会被判成「没人认领」，退回内置编辑器。
   * 会话恢复（重开应用时还原上次打开的文件）正好就落在这个窗口里。
   */
  private initialActivation: Promise<void> = Promise.resolve();
  /** 禁用列表的落盘位置 */
  private readonly stateFilePath: string;

  constructor(options: ExtensionManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.registry = normalizeRegistryBase(options.registry);
    this.extensionsDir = path.join(app.getPath('userData'), 'extensions');
    this.stateFilePath = path.join(app.getPath('userData'), 'extensions-state.json');

    if (options.onMessage) {
      this.messageHandlers.add(options.onMessage);
    }

    // 创建 Extension Host
    this.extensionHost = new ExtensionHost({
      workspaceRoot: this.workspaceRoot,
      onCommand: this.handleCommand.bind(this),
      onMessage: this.handleMessage.bind(this),
      onWebviewViewRegister: this.handleWebviewViewRegister.bind(this),
      // 自定义编辑器保存时走这条路（Office Viewer 改 markdown 就是）
      onApplyEdit: this.applyWorkspaceEdit.bind(this),
      // 「跟用户说话」的那几条：提示 / 系统对话框 / 打开外链。
      // 没有它们，扩展的错误提示会被丢掉、对话框会被当成「用户取消」——
      // 用户看到的就是「按钮点了没反应」。
      onNotify: (level, message) => this.notifyRenderer(level, message),
      onOpenDialog: (options) => this.showOpenDialog(options),
      onSaveDialog: (options) => this.showSaveDialog(options),
      onQuickPick: (items, options) => this.showQuickPick(items, options),
      onOpenExternal: (url) => this.openExternal(url),
      // 扩展开一个 webview 面板（Claude Code 的「+」新会话走这里）。
      // 以前这个 API 在 shim 里是空壳：HTML 被丢掉、标签不出现，而扩展那边
      // 已经把会话记成「在面板里」，于是侧栏被清空 —— 用户看到的就是
      // 「点 + 没生效，当前窗口却被重置了」。现在真的开成一个编辑器标签。
      onWebviewPanel: (spec) => this.createExtensionWebviewPanel(spec),
    });

    // 把 `vscode` 模块落到扩展目录旁（ESM 扩展只能靠真模块解析，require 补丁拦不住）。
    // 在构造时就发起，但真正等它的是 ensureVscodeShim —— 安装/加载扩展前都会 await 一次，
    // 免得「刚好在写盘那一刻点安装」这种竞态。
    this.vscodeShimReady = this.ensureVscodeShim();

    /**
     * IPC 处理器在**构造时**就注册，不等 `initialize()`。
     *
     * 踩过一次：主进程是「窗口先起来、扩展管理器延迟 2 秒再初始化」的，而渲染层
     * 一挂载就会问扩展的事（会话恢复问「这个文件归谁」、启动时推主题变量、拉命令列表）。
     * 那 2 秒里这些 invoke 全部落到「No handler registered」上 —— 主进程日志里
     * 留着一排这样的报错。后果不是「晚两秒才生效」，而是**又静默又持久**：
     * 会话恢复问不到答案，.md 就被当成普通文本恢复，之后点它只是切前台，
     * 用户看到的是「装了 Office Viewer 却一直不生效」。
     */
    this.registerIpcHandlers();
  }

  /**
   * 初始化扩展管理器
   */
  async initialize(): Promise<void> {
    // 确保扩展目录存在
    await fs.mkdir(this.extensionsDir, { recursive: true });

    // 先读禁用列表，再扫目录：不然被禁用的扩展会在启动时被加载一遍
    await this.loadDisabledState();

    // IPC 处理器在构造函数里已经注册过了（见那里的注释），这里不重复注册

    // 扩展 webview 的资源协议。必须在任何扩展激活**之前**就位：
    // 扩展在 activate 里注册视图时就会调 asWebviewUri 拼地址（见 registerWebviewProtocol）。
    this.registerWebviewProtocol();

    console.log(`Extension Manager initialized. Extensions dir: ${this.extensionsDir}`);

    // 自动加载所有已安装的扩展
    await this.loadInstalledExtensions();
  }

  /**
   * 注册 `echoly-webview://` 协议，并算出访客 preload 的地址。
   *
   * 为什么不是 `file://`：扩展的 bundle 是 `<script type="module">`，
   * Chromium 禁止从 `file://` 加载 module script，而且 `file://` 路径里的空格也是坏的。
   * 详见 extensionWebview.ts 顶部的说明。
   *
   * 注册到**两个** session：主窗口用默认 session，而扩展视图的 `<webview>` 带
   * `partition="persist:claude-extension"`，那是另一个 session —— 只注册默认的那个，
   * 视图进程里就取不到任何资源，报的还是会话内 404。
   */
  private registerWebviewProtocol(): void {
    this.webviewPreloadUrl = pathToFileURL(
      path.join(__dirname, '../preload/webview-guest.js'),
    ).toString();

    const handler = (request: { url: string }) => this.handleWebviewRequest(request.url);
    const targets: { protocol: typeof protocol }[] = [
      { protocol: session.defaultSession.protocol },
      { protocol: session.fromPartition(EXTENSION_WEBVIEW_PARTITION).protocol },
    ];
    for (const target of targets) {
      try {
        target.protocol.handle(EXTENSION_WEBVIEW_SCHEME, handler);
      } catch (err: any) {
        // 「已注册」是重启窗口时的正常情况（主进程不重启，但 initialize 可能再跑一次）
        console.warn('[ExtensionManager] 注册 webview 协议失败：', err?.message ?? err);
      }
    }
  }

  /**
   * 响应 `echoly-webview://ext/<viewId>/<relPath>`。
   *
   * - `/<viewId>/index.html` → 之前 resolveWebviewView 生成并存下的 HTML；
   * - 其余路径 → 扩展目录里的真实文件（扩展的 bundle / CSS / 字体 / 图片）。
   *
   * 取不到就回 404，不抛异常：一个找不到的字体不该让整个渲染进程看到一个协议错误。
   */
  private async handleWebviewRequest(rawUrl: string): Promise<Response> {
    const parsed = parseWebviewRequest(rawUrl);
    if (!parsed) {
      return new Response('bad request', { status: 400, headers: TEXT_PLAIN_HEADERS });
    }

    const { viewId, relPath } = parsed;
    if (relPath === WEBVIEW_THEME_PATH) {
      return new Response(this.buildThemeCss(), {
        status: 200,
        headers: { 'content-type': 'text/css; charset=utf-8' },
      });
    }
    if (relPath === WEBVIEW_INDEX_PATH) {
      const html = this.webviewHtml.get(viewId);
      if (html === undefined) {
        return new Response(
          `no html for view "${viewId}" — 该视图还没有被 resolve 过（先调用 extension:resolve-webview）`,
          { status: 404, headers: TEXT_PLAIN_HEADERS },
        );
      }
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    // 资源根目录按 key 查而不是按「有没有这个视图 provider」：自定义编辑器面板也走
    // 同一条协议，它们没有 provider（只有 HTML），但一样要从扩展目录里取资源。
    const extensionRoot = this.resourceRoots.get(viewId);
    if (!extensionRoot) {
      return new Response(`no resource root for "${viewId}"`, {
        status: 404,
        headers: TEXT_PLAIN_HEADERS,
      });
    }

    const filePath = resolveWebviewFilePath(extensionRoot, relPath);
    if (!filePath) {
      // 目录穿越（或路径形状不对）：明确 403，不要静默 404 —— 静默会让人以为是文件不存在
      return new Response('forbidden', { status: 403, headers: TEXT_PLAIN_HEADERS });
    }

    try {
      await fs.access(filePath);
    } catch {
      console.warn(`[ExtensionManager] webview 资源不存在：${viewId} → ${relPath}`);
      return new Response('not found', { status: 404, headers: TEXT_PLAIN_HEADERS });
    }
    // net.fetch 会带上正确的 content-type 并流式返回，不必自己判断扩展名
    return net.fetch(pathToFileURL(filePath).toString());
  }

  /** 扩展视图的初始地址（渲染进程拿它当 `<webview src>`）。 */
  getWebviewUrl(viewId: string): string {
    return buildWebviewUrl(viewId, WEBVIEW_INDEX_PATH);
  }

  /** 主题变量样式表的地址（渲染进程可以拿它做热更新）。 */
  getWebviewThemeUrl(viewId: string): string {
    return buildWebviewUrl(viewId, WEBVIEW_THEME_PATH);
  }

  /**
   * 渲染进程推过来的 `--vscode-*` 变量。存下来给之后生成的 HTML 用，
   * 同时广播出去，让**已经打开**的扩展界面也立刻换色（不用重开标签）。
   */
  setWebviewTheme(vars: Record<string, string>): void {
    this.webviewThemeVars = vars ?? {};
    this.broadcastToRenderers('extension:webview-theme', { vars: this.webviewThemeVars });
  }

  /**
   * 生成主题 CSS。
   *
   * 空值不写：写一个空值比不写更糟 —— CSS 变量为空会让 `var(...)` 解析成一个
   * 无效值，声明整个作废，而扩展那边看起来就是「这块没上色」，很难查。
   */
  private buildThemeCss(): string {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(this.webviewThemeVars)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      // 渲染进程给的是 VS Code 那半边名字（`editor-background`）；也接受已经带前缀的写法，
      // 免得两边约定悄悄漂移成「我发 --vscode-x 你给 x 加了第二层前缀」。
      const property = name.startsWith('--') ? name : `--vscode-${name}`;
      // 只放行变量名该有的字符：这是一张会写进别人页面的样式表
      if (!/^--[A-Za-z0-9_-]+$/.test(property)) continue;
      lines.push(`${property}:${value};`);
    }
    return `/* 由 Echoly 注入：扩展界面的 --vscode-* 主题变量 */\n:root{${lines.join('')}}\n`;
  }

  /**
   * 把主题样式表的 `<link>` 塞进扩展页面的 `<head>`。
   *
   * 放在 head 末尾（扩展自己的 `<style>` 之后）：自定义属性只比「谁最后定义」——
   * 扩展那边还有一段 `<style id="…-font-configuration">` 也是定义变量的，
   * 我们排在后面才能盖住它的默认值。
   */
  private injectThemeLink(html: string, viewId: string): string {
    const link = `<link rel="stylesheet" href="${this.getWebviewThemeUrl(viewId)}">`;
    if (html.includes('</head>')) return html.replace('</head>', `${link}</head>`);
    // 没有 head（理论上不会）就退到内联样式，至少别让界面是裸的
    return `<style>${this.buildThemeCss().replace(/^:root/, ':root')}</style>${html}`;
  }

  /** `<webview>` 的访客 preload 地址（file:// URL）。 */
  getWebviewPreloadUrl(): string {
    return this.webviewPreloadUrl;
  }

  /**
   * 扩展页面发回来的消息 → 交给注册这个视图的扩展。
   *
   * 这是「界面能用」的另一半：没有它，面板画得出来但点任何按钮都没反应。
   */
  deliverWebviewMessage(viewId: string, message: any): void {
    /**
     * 记一行「界面点了什么」。
     *
     * 扩展界面里的按钮点了没反应时，最先要回答的问题就是「这一下到底有没有到主进程」。
     * 没有这行日志，只能靠猜。只记类型不记载荷（载荷里有对话内容）。
     */
    console.log(`[webview→扩展] ${viewId}: ${describeWebviewMessage(message)}`);

    /**
     * 面板的回调存在 shim 那边（`webview.onDidReceiveMessage` 是扩展在面板对象上注册的），
     * 所以这里走 shim 投递，而不是主进程这张 handler 表。
     */
    if (this.webviewPanels.has(viewId)) {
      this.extensionHost.deliverPanelMessage(viewId, message);
      return;
    }

    const handlers = this.webviewMessageHandlers.get(viewId);
    if (!handlers || handlers.size === 0) {
      console.warn(`[ExtensionManager] 视图 ${viewId} 没有注册 onDidReceiveMessage，消息被丢弃`);
      return;
    }
    for (const handler of Array.from(handlers)) {
      try {
        handler(message);
      } catch (err) {
        console.error(`[ExtensionManager] 处理视图 ${viewId} 的消息时出错：`, err);
      }
    }
  }

  /**
   * 自动加载已安装的扩展
   */
  private async loadInstalledExtensions(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    try {
      // 用扫描结果而不是裸 readdir：判「有没有被禁用」要用扩展 id，
      // 而目录名可能是 `claude-code` 这种和 id 对不上的名字。
      for (const record of await this.scanInstalledDirs()) {
        if (this.disabledExtensions.has(record.id) || this.disabledExtensions.has(record.dir)) {
          console.log(`Skipping disabled extension: ${record.id}`);
          continue;
        }
        console.log(`Auto-loading extension: ${record.id}`);
        // 异步加载，不阻塞启动 —— 但把 promise 收起来，见 initialActivation
        pending.push(
          this.loadExtensionFromPath(path.join(this.extensionsDir, record.dir, 'extension')).catch(
            (err) => {
              console.error(`Failed to auto-load extension ${record.id}:`, err.message);
            },
          ),
        );
      }
    } catch (err) {
      console.error('Failed to scan extensions directory:', err);
    } finally {
      // allSettled 而不是 all：一个扩展崩了不该让「等启动激活」永远挂着
      this.initialActivation = Promise.allSettled(pending).then(() => undefined);
    }
  }

  /**
   * 扫一遍扩展目录，建立「目录名 ↔ 扩展 id」的映射。
   *
   * 只在能读到 `extension/package.json` 时才算一条记录：半截安装的目录不该出现在
   * 「已安装」列表里，也没有 id 可用于归属判断。
   */
  private async scanInstalledDirs(): Promise<InstalledRecord[]> {
    const entries = await fs.readdir(this.extensionsDir, { withFileTypes: true }).catch(() => []);
    const out: InstalledRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await fs.readFile(
          path.join(this.extensionsDir, entry.name, 'extension', 'package.json'),
          'utf8',
        );
        const manifest = JSON.parse(raw);
        const id =
          manifest?.publisher && manifest?.name
            ? `${manifest.publisher}.${manifest.name}`
            : entry.name;
        out.push({ dir: entry.name, id, manifest });
      } catch {
        // 半截安装 / 没有 package.json：跳过
      }
    }
    return out;
  }

  /** 按扩展 id 找磁盘目录名；找不到再按目录名本身找一次（本地 VSIX 的目录名可能就是 id）。 */
  private async resolveExtensionDir(id: string): Promise<string | null> {
    const lower = id.toLowerCase();
    const all = await this.scanInstalledDirs();
    const hit =
      all.find((r) => r.id.toLowerCase() === lower) ??
      all.find((r) => r.dir.toLowerCase() === lower);
    return hit?.dir ?? null;
  }

  /**
   * 下载并安装 Claude Code 扩展
   */
  async installClaudeCodeExtension(): Promise<void> {
    try {
      console.log('Installing Claude Code extension...');

      // 下载扩展，带进度回调
      const vsixPath = await downloadClaudeCodeExtension(this.extensionsDir, (progress) => {
        this.broadcastDownloadProgress({ ...progress, id: CLAUDE_CODE_ID, name: CLAUDE_CODE_NAME });
      });

      // 解压并加载
      const extractDir = path.join(this.extensionsDir, 'claude-code');
      const extension = await loadExtensionFromVsix(vsixPath, extractDir);

      console.log(
        `Claude Code extension loaded: ${extension.manifest.displayName} v${extension.manifest.version}`,
      );

      // 激活扩展
      await this.extensionHost.activateExtension(extension);

      console.log('Claude Code extension activated successfully');
    } catch (err) {
      console.error('Failed to install Claude Code extension:', err);
      throw err;
    }
  }

  /**
   * 确保磁盘上有 `vscode` shim 模块（幂等）。
   *
   * 失败**不致命**：CommonJS 的扩展仍然能通过 `Module.prototype.require` 的补丁解析到
   * `vscode`，只有 ESM 形式的扩展会因此加载不了 —— 那种情况由 loadExtension 记录原因，
   * 最终会显示在安装结果里，而不是静默地「装上了但没反应」。
   */
  private async ensureVscodeShim(): Promise<void> {
    try {
      await writeVscodeShimModule(
        path.join(this.extensionsDir, 'node_modules'),
        Object.keys(this.extensionHost.vscodeApi),
      );
    } catch (err) {
      console.warn('[ExtensionManager] 写入 vscode shim 模块失败', err);
    }
  }

  /**
   * 在 Open VSX 上搜索扩展。
   *
   * 走注册表公开 API，不需要 token。失败时返回空列表 + 原因，而不是抛错 ——
   * 市场搜不到不该让整个扩展面板变成错误页（已经装好的扩展仍然能用）。
   */
  async searchMarketplace(
    query: string,
    size = 20,
  ): Promise<{ ok: boolean; extensions: MarketplaceExtension[]; error?: string }> {
    const trimmed = query.trim();
    if (!trimmed) return { ok: true, extensions: [] };

    try {
      const res = await fetch(buildSearchUrl(this.registry, trimmed, size), {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return { ok: false, extensions: [], error: `注册表返回 ${res.status}` };
      }
      const payload = await res.json();
      return { ok: true, extensions: parseOpenVsxSearch(payload, this.registry) };
    } catch (err: any) {
      // 内网/离线环境很常见，说清是网络问题而不是「没有这个扩展」
      return { ok: false, extensions: [], error: `无法访问注册表：${err?.message ?? err}` };
    }
  }

  /** 广播一条下载进度（带扩展身份，见 downloadProgressPayload 的说明）。 */
  private broadcastDownloadProgress(payload: DownloadProgressPayload): void {
    this.broadcastToRenderers('extension:download-progress', payload);
  }

  /**
   * 拉取「推荐」列表（热门扩展）。
   *
   * 与 searchMarketplace 的区别：那个是用户带着关键词来的，空 query 直接拒掉；
   * 这个是替用户挑，走同一接口但按下载量倒序、空 query。
   *
   * 去重按 id：注册表偶尔会为同一扩展返回多个条目。
   */
  async getRecommendedExtensions(
    size = DEFAULT_RECOMMENDED_SIZE,
  ): Promise<{ ok: boolean; extensions: MarketplaceExtension[]; error?: string }> {
    // 要 3 倍于目标条数：平台专属的条目会被筛掉，只按 size 要就会筛出不满一屏。
    // 上限沿用注册表的单页上限，别把一个防御性常量复制成两份。
    const requestSize = Math.min(MAX_MARKETPLACE_PAGE_SIZE, Math.max(size, size * 3));
    try {
      const res = await fetch(buildRecommendedUrl(this.registry, requestSize), {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        return { ok: false, extensions: [], error: `注册表返回 ${res.status}` };
      }
      const payload = await res.json();
      const seen = new Set<string>();
      const extensions: MarketplaceExtension[] = [];
      for (const item of parseOpenVsxSearch(payload, this.registry)) {
        // 见 isPlatformAgnosticDownload 的说明：推荐列表里放一份装不上的构建，
        // 点安装必然出问题，不如少推一个。
        if (!isPlatformAgnosticDownload(item.downloadUrl)) continue;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        extensions.push(item);
        if (extensions.length >= size) break;
      }
      return { ok: true, extensions };
    } catch (err: any) {
      return { ok: false, extensions: [], error: `无法访问注册表：${err?.message ?? err}` };
    }
  }

  /**
   * 拉一个扩展的详情（含 README）。
   *
   * 详情页要的东西（体积、发布时间、许可、分类、仓库）搜索接口给不了，
   * 所以点开某个扩展时单独拉一次；README 是另一个文件端点。
   *
   * 两处失败都**不抛错**，而是各自留空：
   * - 详情拿不到：调用方用搜索结果那一份渲染，少几行元信息而已；
   * - README 拿不到：正文区显示一句「注册表没有提供说明」。
   * 详情页因为一个附加信息拉不到就整个变错误页，是过度反应。
   */
  async getExtensionDetail(id: string): Promise<{
    ok: boolean;
    error?: string;
    detail?: MarketplaceDetail;
    readme?: string;
  }> {
    const parts = splitExtensionId(id);
    if (!parts) return { ok: false, error: `扩展 id 不合法：${id}` };

    let detail: MarketplaceDetail | undefined;
    try {
      const res = await fetch(`${this.registry}/api/${parts.namespace}/${parts.name}`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { ok: false, error: `注册表返回 ${res.status}` };
      const payload = await res.json();
      detail = parseOpenVsxDetail(payload, this.registry) ?? undefined;
    } catch (err: any) {
      return { ok: false, error: `无法访问注册表：${err?.message ?? err}` };
    }
    if (!detail) return { ok: false, error: '注册表返回的数据无法解析' };

    const readme = await this.fetchReadme(detail);
    return { ok: true, detail, ...(readme ? { readme } : {}) };
  }

  /**
   * 抓 README 正文。
   *
   * 地址来自**校验过的 id / 版本号**，以及注册表自己在详情里给的 `files.readme`，
   * 不是渲染层传进来的任意 URL —— 这个方法是主进程代渲染层发请求，
   * 能抓什么必须由这里说了算（候选地址一律过 isRegistryOriginUrl）。
   * 注册表会 302 到这个文件的 CDN，所以这里跟随重定向（fetch 默认行为）；
   * 能跳到哪去由配置的注册表决定，属于用户自己的信任边界。
   *
   * 逐个试 `buildReadmeCandidates` 给的地址：平台专属扩展（Claude Code 就是）
   * 的文件挂在平台路径下，只拼 `/{version}/file/README.md` 会 404，
   * 详情页于是显示「注册表没有提供说明文档」—— 而它其实有。
   */
  private async fetchReadme(detail: MarketplaceDetail): Promise<string | undefined> {
    const candidates = buildReadmeCandidates(
      this.registry,
      detail.id,
      detail.version,
      detail.readmeUrl,
    );
    for (const url of candidates) {
      const text = await this.fetchReadmeText(url);
      if (text) return text;
    }
    return undefined;
  }

  /** 抓一个 README 地址。抓不到（404 / 超时 / 空）都返回 undefined，交给下一个候选。 */
  private async fetchReadmeText(url: string): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), readmeFetchTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return undefined;
      const stated = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(stated) && stated > maxReadmeBytes) return undefined;
      const text = await res.text();
      // 有的注册表把 README 当二进制流返回（content-type 是 octet-stream），
      // 所以不看 content-type，只按长度与内容本身判断
      if (!text.trim()) return undefined;
      return text.length > maxReadmeChars ? `${text.slice(0, maxReadmeChars)}\n\n…` : text;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 抓一个扩展图标并转成 data URL（渲染进程的 CSP 只放行 `data:`）。
   *
   * 只有配置的那个注册表 origin 上的地址会被抓 —— 否则这个方法就是一个
   * 「替渲染进程请求任意 URL」的探针。判定见 isAllowedIconUrl。
   * 抓不到就返回 null，让渲染层回退到首字母头像：图标是装饰，不该让列表变红。
   */
  async getIconDataUrl(iconUrl: string): Promise<string | null> {
    if (!isAllowedIconUrl(this.registry, iconUrl)) return null;
    if (this.iconCache.has(iconUrl)) return this.iconCache.get(iconUrl) ?? null;

    let dataUrl: string | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(iconUrl, { signal: controller.signal });
      // 先看声明的长度再读 body：不然一个几百 MB 的响应会先进内存再被丢弃。
      // 声明值可能缺失或撒谎，所以 toIconDataUrl 里还会按实际字节数再判一次。
      const declared = Number(res.headers.get('content-length') ?? '');
      const oversize = Number.isFinite(declared) && declared > MAX_ICON_BYTES;
      if (res.ok && !oversize) {
        dataUrl = toIconDataUrl(
          res.headers.get('content-type'),
          new Uint8Array(await res.arrayBuffer()),
        );
      }
    } catch {
      // 超时/断网/非图片内容都在这里收敛成 null，不向上抛
      dataUrl = null;
    } finally {
      clearTimeout(timer);
    }

    if (this.iconCache.size >= ICON_CACHE_LIMIT) this.iconCache.clear();
    this.iconCache.set(iconUrl, dataUrl);
    return dataUrl;
  }

  /**
   * 从市场安装一个扩展。
   *
   * id 会变成 `extensionsDir` 下的文件名与目录名，所以**先校验再用**：
   * 含 `../` 的 id 能把解压目标指到扩展目录之外，而 `unzip -o` 会照做。
   * 校验用注册表那一套严格规则（`isSafeExtensionId`），不在这里另写一遍。
   */
  async installFromMarketplace(extension: {
    id: string;
    downloadUrl: string;
    version?: string;
    /** 展示名，只用来在进度里显示「正在装什么」 */
    displayName?: string;
  }): Promise<{ warning?: string }> {
    if (!isSafeExtensionId(extension.id)) {
      throw new Error(`扩展 id 不合法，已拒绝安装：${extension.id}`);
    }
    if (!/^https?:\/\//i.test(extension.downloadUrl ?? '')) {
      throw new Error('下载地址不合法（必须是 http/https）');
    }

    await this.vscodeShimReady;
    // 平台专属扩展要先挑出**本机能用的那一份**，见 resolveDownloadForThisMachine
    const resolved = await this.resolveDownloadForThisMachine(extension.id, extension.downloadUrl);
    const vsixPath = path.join(this.extensionsDir, `${extension.id}.vsix`);
    const extractDir = path.join(this.extensionsDir, extension.id);

    // 进度必须带上是**哪个**扩展：面板里可以同时装好几个，
    // 一条不带身份的「正在下载…」等于没说。
    const progressId = { id: extension.id, name: extension.displayName || extension.id };
    try {
      await downloadVsix(resolved.downloadUrl, vsixPath, (progress) => {
        this.broadcastDownloadProgress({ ...progress, ...progressId });
      });
    } finally {
      // 无论成功失败都要发一条「结束」：失败了还留着一条不动的进度条，
      // 用户会以为它还在下载。
      this.broadcastDownloadProgress({
        ...progressId,
        percent: 100,
        downloaded: 0,
        total: 0,
        done: true,
      });
    }

    const loaded = await loadExtensionFromVsix(vsixPath, extractDir);
    this.loadedExtensionPaths.add(path.join(extractDir, 'extension'));

    // 文件已经装好了，所以激活失败**不算安装失败** —— 报成失败会让人以为得重装。
    // 但也不能吞掉：那正是「装上了却什么都没发生」的由来。返回一句说明，由界面转达。
    try {
      await this.extensionHost.activateExtension(loaded);
      console.log(
        `[ExtensionManager] 已从市场安装并激活：${extension.id} v${loaded.manifest.version}`,
      );
      return resolved.warning ? { warning: resolved.warning } : {};
    } catch (err: any) {
      console.warn(`[ExtensionManager] ${extension.id} 已安装但激活失败：`, err);
      const reason = `已安装，但激活失败：${err?.message ?? err}`;
      // 平台对不上往往就是激活失败的原因，两句都留着，省得下一次再去查
      return { warning: resolved.warning ? `${reason}（${resolved.warning}）` : reason };
    }
  }

  /**
   * 挑出**本机能用的**那个构建。
   *
   * 搜索接口不返回 `targetPlatform`（实测是 null），但 `files.download` 的文件名里
   * 带着平台后缀 —— Claude Code 就是 `…@alpine-arm64.vsix`。
   * 于是「搜索结果那一行的安装按钮」会去下一个给 Alpine（musl）用的包，
   * 而用户可能正在 macOS 上点它。装上之后能不能跑，要等激活时才知道。
   *
   * 处理方式：地址里没有平台后缀（通用构建）或者本来就是本机平台的，直接用；
   * 否则按平台路径问注册表要本机那一份。注册表也没有的话就照原样装，
   * 但把这件事写进安装结果 —— 「装上了但用不了」不该是一句没有线索的报错。
   *
   * 刻意**不**在这里抛错：平台专属的扩展里也有纯 JS 的，装在别的平台上照样能用。
   * 把「可能不适用」当成「一定不能用」，会让本来能装的扩展装不上。
   */
  private async resolveDownloadForThisMachine(
    id: string,
    downloadUrl: string,
  ): Promise<{ downloadUrl: string; warning?: string }> {
    const decision = decidePlatformDownload(downloadUrl, process.platform, process.arch);
    if (decision.kind !== 'needs-local-build') return { downloadUrl };
    const { wantedPlatform, givenPlatform } = decision;

    try {
      const res = await fetch(buildDetailUrl(this.registry, id, wantedPlatform), {
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const detail = parseOpenVsxDetail(await res.json(), this.registry);
        if (detail && parseTargetPlatform(detail.downloadUrl) === wantedPlatform) {
          console.log(
            `[ExtensionManager] ${id} 改用 ${wantedPlatform} 构建：${detail.downloadUrl}`,
          );
          return { downloadUrl: detail.downloadUrl };
        }
      }
    } catch (err: any) {
      console.warn(
        `[ExtensionManager] 查 ${id} 的 ${wantedPlatform} 构建失败：`,
        err?.message ?? err,
      );
    }
    return {
      downloadUrl,
      warning: `注册表没有 ${wantedPlatform} 的构建，装的是 ${givenPlatform} 那一份，可能加载不了原生模块`,
    };
  }

  /**
   * 从本地路径加载扩展
   */
  async loadExtensionFromPath(extensionPath: string): Promise<void> {
    // 规范化路径
    const normalizedPath = path.resolve(extensionPath);

    // 检查是否已加载
    if (this.loadedExtensionPaths.has(normalizedPath)) {
      console.log(`Extension already loaded: ${normalizedPath}`);
      return;
    }

    try {
      let extension: any;
      let finalPath = normalizedPath;

      // 检查是否是 .vsix 文件
      if (extensionPath.endsWith('.vsix')) {
        // 解压到 extensions 目录
        const extensionName = path.basename(extensionPath, '.vsix');
        const extractDir = path.join(this.extensionsDir, extensionName);

        console.log(`Loading .vsix file: ${extensionPath}`);
        console.log(`Extract to: ${extractDir}`);

        extension = await loadExtensionFromVsix(extensionPath, extractDir);
        finalPath = path.join(extractDir, 'extension');
      } else {
        // 直接加载目录
        extension = await loadExtension(extensionPath);
      }

      await this.extensionHost.activateExtension(extension);

      // 标记为已加载
      this.loadedExtensionPaths.add(finalPath);

      console.log(`Extension loaded and activated: ${extension.manifest.displayName}`);
    } catch (err) {
      console.error(`Failed to load extension from ${extensionPath}:`, err);
      throw err;
    }
  }

  /**
   * 执行扩展命令
   */
  async executeCommand(command: string, ...args: any[]): Promise<any> {
    return this.extensionHost.executeCommand(command, ...args);
  }

  /**
   * 已安装扩展的登记表（面板与详情页的管理界面都吃这一份）。
   *
   * 与 `getLoadedExtensions` 的区别：那个只返回「活着的」id 字符串，够用来判断
   * 「装没装」；管理界面还要知道版本、是启用还是禁用、贡献了哪些命令与视图 ——
   * 否则「禁用」「打开视图」这些按钮就没有落点。
   */
  async listInstalledExtensions(): Promise<InstalledExtensionInfo[]> {
    const loaded = new Set(this.extensionHost.getLoadedExtensions());
    const registeredCommands = this.extensionHost.listExtensionCommands();
    const titles = await this.readCommandTitles();
    const out: InstalledExtensionInfo[] = [];

    // 走扫描而不是裸 readdir：列表里的 id 必须是**扩展 id**（宿主记的那个），
    // 而目录名可能是 `claude-code` 这种和 id 对不上的名字。
    for (const record of await this.scanInstalledDirs()) {
      const { id, manifest } = record;
      const enabled = !this.disabledExtensions.has(id) && !this.disabledExtensions.has(record.dir);
      out.push({
        id,
        displayName: manifest.displayName || manifest.name || id,
        version: manifest.version,
        enabled,
        // `active` 与 `enabled` 是两回事：启用了的扩展也可能因为激活失败而没跑起来
        active: loaded.has(id),
        commands: registeredCommands
          .filter((c) => c.extensionId === id)
          .map((c) => ({ command: c.command, title: titles.get(c.command) || c.command })),
        views: this.extensionHost.listWebviewViewIds(id),
      });
    }

    // 稳定排序：列表每次刷新都换顺序的话，「禁用」按钮会跑到别处去
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 所有由扩展贡献的命令（命令面板用）。
   *
   * 只给命令 id 是不够用的：命令面板里列出一串 `claude-code.something` 用户看不懂。
   * 命令的**人类可读名字**写在扩展 package.json 的 `contributes.commands[].title` 里，
   * 所以这里顺手把每个扩展的 title 读出来配上；读不到就退回命令 id。
   */
  async listExtensionCommands(): Promise<
    { command: string; extensionId?: string; title?: string }[]
  > {
    const registered = this.extensionHost.listExtensionCommands();
    const titles = await this.readCommandTitles();
    return registered.map((c) => ({
      ...c,
      title: titles.get(c.command) || c.command,
    }));
  }

  /** 扫一遍已安装扩展的 package.json，收集 `command → title`。 */
  private async readCommandTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    for (const { manifest } of await this.scanInstalledDirs()) {
      const contributed = manifest?.contributes?.commands;
      if (!Array.isArray(contributed)) continue;
      for (const c of contributed) {
        if (c && typeof c.command === 'string' && typeof c.title === 'string') {
          titles.set(c.command, c.title);
        }
      }
    }
    return titles;
  }

  /**
   * 启用 / 禁用扩展。
   *
   * 禁用 = 调 deactivate（扩展自己的清理逻辑会跑）+ 摘掉它注册的命令与视图 +
   * 记进禁用列表（重启后不再加载）。启用 = 反过来，并且**就地激活**，
   * 不必等下次启动 —— 用户点「启用」的意思就是现在就要能用。
   */
  async setExtensionEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!isSafeExtensionId(id)) return { ok: false, error: `扩展 id 不合法：${id}` };
    // 目录名不一定等于 id（Claude Code 就装在 `claude-code/` 下），路径必须按目录名拼
    const dir = await this.resolveExtensionDir(id);
    if (!dir) return { ok: false, error: `找不到扩展目录：${id}` };
    const extensionPath = path.join(this.extensionsDir, dir, 'extension');

    try {
      if (enabled) {
        if (this.disabledExtensions.delete(id)) await this.persistDisabledState();
        // 兼容按目录名存下的旧值
        if (this.disabledExtensions.delete(dir)) await this.persistDisabledState();
        if (!this.extensionHost.getLoadedExtensions().includes(id)) {
          await fs.access(path.join(extensionPath, 'package.json'));
          await this.loadExtensionFromPath(extensionPath);
        }
        return { ok: true };
      }

      if (!this.disabledExtensions.has(id)) {
        this.disabledExtensions.add(id);
        await this.persistDisabledState();
      }
      await this.extensionHost.deactivateExtension(id);
      this.loadedExtensionPaths.delete(extensionPath);
      this.forgetExtensionViews(id, dir);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * 卸载扩展：停用 → 删掉解压目录与 .vsix。
   *
   * 先 deactivate 再删文件：扩展的 deactivate() 里可能有落盘动作（写状态、关连接），
   * 文件先没了它就只能抛错。删不掉就把真实原因返回给界面，不假装成功。
   */
  async uninstallExtension(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!isSafeExtensionId(id)) return { ok: false, error: `扩展 id 不合法：${id}` };

    const dir = await this.resolveExtensionDir(id);
    if (!dir) return { ok: false, error: `找不到扩展目录：${id}` };

    try {
      await this.extensionHost.deactivateExtension(id);
      this.loadedExtensionPaths.delete(path.join(this.extensionsDir, dir, 'extension'));
      this.forgetExtensionViews(id, dir);

      await fs.rm(path.join(this.extensionsDir, dir), { recursive: true, force: true });
      // vsix 与目录同名（Claude Code 是 `claude-code.vsix` / `claude-code/`）
      await fs.rm(path.join(this.extensionsDir, `${dir}.vsix`), { force: true });

      // 卸载之后这条 id 不该再留在禁用名单里：重装一次就该能用
      if (this.disabledExtensions.delete(id)) await this.persistDisabledState();
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: `卸载失败：${err?.message ?? err}` };
    }
  }

  /**
   * 把某个扩展注册的全部视图从 manager 的两本账里摘掉（归属表 + provider 表）。
   *
   * shim 那边的归属表在 `deactivateExtension` 里已经摘过了，所以这里**不能**再靠
   * `viewOwners` 去找 —— 那本账已经空了。改为直接看 `viewOwners` 里剩下的归属
   * （扩展忘记 dispose 的情况）+ provider 表里带 extensionPath 的兜底。
   */
  private forgetExtensionViews(id: string, dir?: string): void {
    const extensionPath = path.join(this.extensionsDir, dir ?? id, 'extension');
    for (const [viewId, owner] of Array.from(this.viewOwners.entries())) {
      if (owner === id) this.viewOwners.delete(viewId);
    }
    for (const [viewId, entry] of Array.from(this.webviewViewProviders.entries())) {
      // 归属表已经空了，只能按 extensionPath 认：一个扩展的视图都写在它自己的目录下
      if (entry?.extensionPath === extensionPath) {
        this.dropViewRuntime(viewId);
      }
    }
  }

  /**
   * 忘掉一个视图的运行时（provider / HTML / 消息回调）。
   *
   * 少了 HTML 与消息回调这两本账，卸载之后那个标签还能打开、还留着上一个扩展的界面，
   * 而且它发回来的消息会打到已经停掉的扩展上。
   */
  private dropViewRuntime(viewId: string): void {
    this.webviewViewProviders.delete(viewId);
    this.webviewHtml.delete(viewId);
    this.webviewMessageHandlers.delete(viewId);
    this.resourceRoots.delete(viewId);
  }

  /** 读禁用列表。文件损坏/不存在都当「没有禁用任何扩展」，不阻断启动。 */
  private async loadDisabledState(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.stateFilePath, 'utf8'));
      const list = Array.isArray(raw?.disabled) ? raw.disabled : [];
      this.disabledExtensions = new Set(list.filter((v: unknown) => typeof v === 'string'));
    } catch {
      this.disabledExtensions = new Set();
    }
  }

  private async persistDisabledState(): Promise<void> {
    const payload = JSON.stringify(
      { disabled: Array.from(this.disabledExtensions).sort() },
      null,
      2,
    );
    try {
      await fs.writeFile(this.stateFilePath, payload, 'utf8');
    } catch (err: any) {
      console.error('[ExtensionManager] 写扩展状态文件失败：', err?.message ?? err);
    }
  }

  // ─────────────────────────── 自定义编辑器 ───────────────────────────

  /**
   * 从各扩展的 manifest 里读 `contributes.customEditors`。
   *
   * 光有 provider 注册是不够的：`registerCustomEditorProvider` 只说「我能画这种
   * viewType」，**哪些文件归它管**写在 manifest 的 selector 里。两张表对上了才算能用。
   */
  private async readCustomEditorContributions(): Promise<
    (CustomEditorContribution & { extensionId: string })[]
  > {
    const out: (CustomEditorContribution & { extensionId: string })[] = [];
    for (const { id, manifest } of await this.scanInstalledDirs()) {
      const list = manifest?.contributes?.customEditors;
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || typeof entry.viewType !== 'string') continue;
        const patterns = Array.isArray(entry.selector)
          ? entry.selector
              .map((s: any) => (typeof s?.filenamePattern === 'string' ? s.filenamePattern : null))
              .filter((p: string | null): p is string => !!p)
          : [];
        if (patterns.length === 0) continue;
        out.push({
          viewType: entry.viewType,
          displayName: typeof entry.displayName === 'string' ? entry.displayName : undefined,
          priority: typeof entry.priority === 'string' ? entry.priority : undefined,
          patterns,
          extensionId: id,
        });
      }
    }
    return out;
  }

  /**
   * 所有能被路由的自定义编辑器（manifest 声明 × 真的注册了 provider）。
   *
   * 也是给界面看的：详情页「贡献的功能」里会列出「能接手哪些文件」。
   */
  async listCustomEditors(): Promise<CustomEditorCandidate[]> {
    const registered = new Set(
      this.extensionHost
        .listCustomEditorProviders()
        .filter((entry) => entry.extensionId)
        .map((entry) => entry.viewType),
    );
    const contributions = await this.readCustomEditorContributions();
    return contributions.map((contribution) => ({
      ...contribution,
      hasProvider: registered.has(contribution.viewType),
    }));
  }

  /**
   * 这个文件该交给谁。
   *
   * 只认 `default` 优先级的接管型 —— `option` 型（Office Viewer 的图片/HTML 预览）
   * 在 VS Code 里也只有用户显式「打开方式」才生效，让它们悄悄抢走 .png/.html 是
   * 行为倒退。返回 null 表示用内置编辑器。
   */
  async matchCustomEditor(filePath: string): Promise<CustomEditorCandidate | null> {
    let candidates = (await this.listCustomEditors()).filter(
      (candidate) => candidate.hasProvider && isDefaultPriority(candidate),
    );

    /**
     * 有人认这个文件、但 provider 还没注册上来 —— 多半是启动时的加载还没跑完。
     *
     * 这时候**等它一下**，而不是直接判「没人认领」：判错的表现是「装了 Office Viewer
     * 却还是内置编辑器」，而用户完全无从判断这是竞态。只在这一种情况下等，
     * 其它文件（没人认领）走的是上面那条零成本的路径。
     */
    if (candidates.length === 0) {
      const relative = this.relativeToWorkspace(filePath);
      const claimed = (await this.listCustomEditors()).filter(
        (candidate) => isDefaultPriority(candidate) && matchesContribution(candidate, relative),
      );
      if (claimed.length > 0) {
        await this.awaitInitialActivation();
        candidates = (await this.listCustomEditors()).filter(
          (candidate) => candidate.hasProvider && isDefaultPriority(candidate),
        );
      }
    }

    if (candidates.length === 0) {
      console.log(`[customEditor] 没人认领 ${filePath}`);
      return null;
    }
    const picked = pickCustomEditor(candidates, this.relativeToWorkspace(filePath));
    console.log(
      `[customEditor] ${filePath} → ${picked ? picked.viewType : '内置编辑器'}` +
        `（候选 ${candidates.length} 个）`,
    );
    return picked;
  }

  /**
   * 磁盘路径 → 相对工作区的路径。
   *
   * manifest 里的 glob 写成「双星 + 后缀」这种相对形状，拿绝对路径去比会全都不匹配。
   * 不在工作区内的（被拖进来的单个文件）原样返回：双星段本来就能吃掉任意层目录，
   * 比强行算出一个 `../../` 更靠谱。
   */
  private relativeToWorkspace(filePath: string): string {
    const root = this.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  }

  /**
   * 用户打开（或切换）了工作区。
   *
   * 三件事，缺一件都会让「扩展认的项目」和用户打开的项目对不上：
   *
   * 1. `workspace.workspaceFolders` —— 扩展按它分组会话、取工作区配置；
   * 2. 自定义编辑器的 glob 匹配用的相对路径基准（`this.workspaceRoot`）；
   * 3. **`process.chdir`** —— 这条最不显眼但要命：扩展宿主跑在主进程里，
   *    而 Claude Code 的 CLI 把「项目」定义成 `process.cwd()`
   *    （它内部 `VB()` 就是 `process.cwd()`，用来初始化 session 的 projectRoot）。
   *    开发时主进程的 cwd 是**应用自己的仓库**，于是「让它分析我打开的项目」会变成
   *    「分析 Echoly 自己」——用户完全无从理解。
   *
   * chdir 是进程级的，所以另外两处「靠 cwd 找自己资源」的地方（node-pty 的
   * spawn-helper、打包好的 runner bundle）已经补上了不依赖 cwd 的候选。
   */
  setWorkspaceRoot(root: string): void {
    if (!root || root === this.workspaceRoot) return;
    this.workspaceRoot = root;
    this.extensionHost.setWorkspaceRoot(root);
    try {
      process.chdir(root);
      console.log(`[ExtensionManager] 扩展宿主的 cwd 跟着工作区走：${root}`);
    } catch (err: any) {
      // 只影响「扩展认哪个目录」，不该把切换工作区这件事本身弄失败
      console.warn(`[ExtensionManager] chdir 失败（${root}）：${err?.message ?? err}`);
    }
  }

  /**
   * 声明认这个文件、但**当前被禁用**的扩展（没有就返回 null）。
   *
   * 只用于给用户一句解释。禁用是用户自己做的选择，但要让他看得见后果：
   * 「这个文件本来归 Office Viewer，你已经把它禁用了」比默默用内置编辑器强得多。
   */
  private async findDisabledClaimant(filePath: string): Promise<string | undefined> {
    if (this.disabledExtensions.size === 0) return undefined;
    const relative = this.relativeToWorkspace(filePath);
    for (const candidate of await this.listCustomEditors()) {
      if (candidate.hasProvider) continue;
      if (!isDefaultPriority(candidate)) continue;
      if (!matchesContribution(candidate, relative)) continue;
      if (!this.disabledExtensions.has(candidate.extensionId)) continue;
      return candidate.extensionId;
    }
    return undefined;
  }

  /**
   * 打开一个自定义编辑器：建面板 → 调扩展的 resolve* → 把 HTML 交给协议。
   *
   * 两种 provider 接口都要支持，实测各占一半：
   * - `CustomTextEditorProvider.resolveCustomTextEditor(document, panel, token)`
   *   —— Office Viewer 的 markdown 编辑器走这条，它要真的 `document.getText()`；
   * - `CustomEditorProvider.openCustomDocument(uri,…)` + `resolveCustomEditor(document, panel, token)`
   *   —— Office Viewer 的表格/压缩包/图片走这条。
   *
   * 两种都失败（provider 没有对应方法）时明确返回失败原因，界面据此退回内置编辑器，
   * 而不是留一个空白标签页。
   */
  async openCustomEditor(filePath: string): Promise<
    | {
        ok: true;
        panelKey: string;
        viewType: string;
        title: string;
        url: string;
        preloadUrl: string;
      }
    | { ok: false; error: string }
  > {
    const candidate = await this.matchCustomEditor(filePath);
    if (!candidate) return { ok: false, error: `没有扩展认领这个文件：${filePath}` };

    const registration = this.extensionHost
      .listCustomEditorProviders()
      .find((entry) => entry.viewType === candidate.viewType);
    const provider = registration ? this.getCustomEditorProvider(candidate.viewType) : null;
    if (!provider) return { ok: false, error: `扩展没有注册 provider：${candidate.viewType}` };

    const dir = await this.resolveExtensionDir(candidate.extensionId);
    if (!dir) return { ok: false, error: `找不到扩展目录：${candidate.extensionId}` };
    const extensionPath = path.join(this.extensionsDir, dir, 'extension');

    const panelKey = `editor:${++this.customEditorSeq}`;
    let html = '';

    // 面板与 webview 的 mock。字段按 VS Code 的语义给，缺一个就是扩展激活路径上的 TypeError。
    const panelRuntime = {
      viewType: candidate.viewType,
      extensionId: candidate.extensionId,
      filePath,
      messageHandlers: new Set<(message: any) => void>(),
      onDispose: new Set<() => void>(),
    };

    const panel: any = {
      viewType: candidate.viewType,
      title: candidate.displayName || path.basename(filePath),
      viewColumn: 1,
      active: true,
      visible: true,
      reveal: () => {},
      dispose: () => this.disposeCustomEditor(panelKey),
      onDidDispose: (cb: () => void) => {
        panelRuntime.onDispose.add(cb);
        return { dispose: () => panelRuntime.onDispose.delete(cb) };
      },
      onDidChangeViewState: () => ({ dispose() {} }),
      webview: this.createCustomEditorWebview(panelKey, panelRuntime, extensionPath, (next) => {
        html = next;
      }),
    };

    const document = this.createTextDocumentMock(filePath);
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    };

    this.customEditorPanels.set(panelKey, panelRuntime);
    this.resourceRoots.set(panelKey, extensionPath);

    try {
      if (typeof provider.resolveCustomTextEditor === 'function') {
        await provider.resolveCustomTextEditor(document, panel, token);
      } else if (typeof provider.resolveCustomEditor === 'function') {
        const custom = await Promise.resolve(
          provider.openCustomDocument?.(document.uri, {}, token),
        );
        await provider.resolveCustomEditor(custom ?? document, panel, token);
      } else {
        throw new Error(
          `provider 既没有 resolveCustomTextEditor 也没有 resolveCustomEditor：${candidate.viewType}`,
        );
      }
    } catch (err: any) {
      console.error(`[customEditor] ${candidate.viewType} 渲染 ${filePath} 失败：`, err);
      this.disposeCustomEditor(panelKey);
      return { ok: false, error: `扩展渲染失败：${err?.message ?? err}` };
    }

    /**
     * 等一小会儿再判失败。
     *
     * 扩展**不一定**在 `resolve*` 里把 html 赋上：Office Viewer 的 markdown 编辑器
     * 在 `resolveCustomTextEditor` 里 `this.handleMarkdown(...)` 是**没有 await** 的，
     * html 要等它内部读完 `index.html` 模板之后才设。立刻判定就会把一个正常的扩展
     * 判成「没给出界面内容」，然后退回内置编辑器 —— 用户看到的是「装了没用」。
     *
     * 只等有限时间：真的没给就明确失败，而不是给界面一个永远打不开的地址。
     */
    for (let waited = 0; !html && waited < CUSTOM_EDITOR_HTML_WAIT_MS; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!html) {
      console.error(
        `[customEditor] ${candidate.viewType} 在 ${CUSTOM_EDITOR_HTML_WAIT_MS}ms 内没有设置 webview.html（${filePath}）`,
      );
      this.disposeCustomEditor(panelKey);
      return { ok: false, error: `扩展没有给出界面内容：${candidate.viewType}` };
    }

    this.webviewHtml.set(panelKey, this.injectThemeLink(this.injectRuntimeScript(html), panelKey));
    console.log(
      `[customEditor] ${candidate.viewType} 打开 ${filePath}（面板 ${panelKey}，${html.length} 字节）`,
    );

    return {
      ok: true,
      panelKey,
      viewType: candidate.viewType,
      title: candidate.displayName || path.basename(filePath),
      url: buildWebviewUrl(panelKey, WEBVIEW_INDEX_PATH),
      preloadUrl: this.getWebviewPreloadUrl(),
    };
  }

  /**
   * 等启动时那批扩展加载完（最多 `INITIAL_ACTIVATION_WAIT_MS`）。
   *
   * 有上限：真有个扩展卡住不动，也不该把「打开文件」这件事一起拖住。
   */
  private async awaitInitialActivation(): Promise<void> {
    await Promise.race([
      this.initialActivation,
      new Promise((resolve) => setTimeout(resolve, INITIAL_ACTIVATION_WAIT_MS)),
    ]);
  }

  /** 自定义编辑器的 `webview` 对象。与视图那份同源，只有 key 与消息集合不同。 */
  private createCustomEditorWebview(
    panelKey: string,
    runtime: { messageHandlers: Set<(message: any) => void> },
    extensionPath: string,
    setHtml: (html: string) => void,
  ): any {
    let options: any = {};
    return {
      set html(value: string) {
        setHtml(value ?? '');
      },
      get html() {
        return '';
      },
      get options() {
        return options;
      },
      set options(value: any) {
        options = value;
      },
      onDidReceiveMessage: (callback: (message: any) => void) => {
        runtime.messageHandlers.add(callback);
        return { dispose: () => runtime.messageHandlers.delete(callback) };
      },
      postMessage: (message: any) => {
        this.broadcastToRenderers('extension:custom-editor-message', { panelKey, message });
        return Promise.resolve(true);
      },
      asWebviewUri: (uri: any) => {
        const fsPath = extractFsPath(uri);
        return buildWebviewUrl(panelKey, toWebviewResourcePath(extensionPath, fsPath));
      },
      cspSource: buildWebviewOrigin(),
    };
  }

  /**
   * 给扩展的 `TextDocument`。
   *
   * `getText()` **每次读盘**而不是缓存：自定义编辑器是「所见即所得」，扩展拿到的必须是
   * 最新内容；缓存一份就要处理失效，而这里读一个文本文件的开销远小于出错的代价。
   * `lineCount` 同理现算 —— Office Viewer 用它构造「全文替换」的范围。
   */
  private createTextDocumentMock(filePath: string): any {
    const fsSync = require('fs') as typeof import('fs');
    const readText = () => {
      try {
        return fsSync.readFileSync(filePath, 'utf8');
      } catch {
        return '';
      }
    };
    /**
     * 用 shim 那个真 Uri，不要手搓字面量。
     *
     * 扩展拿到 `document.uri` 之后会当 `vscode.Uri` 用：Office Viewer 的 markdown
     * 编辑器一上来就 `uri.with({ query: '', fragment: '' })` 当缓存键，字面量对象没有
     * `with`，整个渲染就断在那儿（而且异常没有人 await，界面上只剩「点了没反应」）。
     */
    const uri = ShimUri.file(filePath);
    return {
      uri,
      fileName: filePath,
      isUntitled: false,
      isDirty: false,
      isClosed: false,
      eol: { value: '\n' },
      encoding: 'utf8',
      get version() {
        return 1;
      },
      get lineCount() {
        const text = readText();
        if (text.length === 0) return 1;
        return text.split(/\r\n|\r|\n/).length;
      },
      getText: () => readText(),
      getWordRangeAtPosition: () => undefined,
      lineAt: (line: number) => ({ lineNumber: line, text: '', range: undefined }),
      offsetAt: () => 0,
      positionAt: () => ({ line: 0, character: 0 }),
      save: () => Promise.resolve(true),
      validateRange: (range: any) => range,
      validatePosition: (position: any) => position,
      onDidChangeContent: () => ({ dispose() {} }),
      onDidChange: () => ({ dispose() {} }),
    };
  }

  /** shim 内部的 provider 对象（按 viewType 取）。 */
  private getCustomEditorProvider(viewType: string): any {
    return (this.extensionHost as any).shim?.customEditorProviders?.get(viewType)?.provider ?? null;
  }

  /** 界面里的操作 → 自定义编辑器扩展的 onDidReceiveMessage。 */
  deliverCustomEditorMessage(panelKey: string, message: any): void {
    console.log(`[webview→扩展] ${panelKey}: ${describeWebviewMessage(message)}`);
    const panel = this.customEditorPanels.get(panelKey);
    if (!panel) {
      console.warn(`[ExtensionManager] 自定义编辑器面板不存在：${panelKey}`);
      return;
    }
    for (const handler of Array.from(panel.messageHandlers)) {
      try {
        handler(message);
      } catch (err) {
        console.error(`[ExtensionManager] 处理 ${panelKey} 的消息时出错：`, err);
      }
    }
  }

  /** 关掉一个自定义编辑器面板（切走标签 / 关标签时调用）。 */
  disposeCustomEditor(panelKey: string): void {
    const panel = this.customEditorPanels.get(panelKey);
    if (!panel) return;
    for (const cb of Array.from(panel.onDispose)) {
      try {
        cb();
      } catch (err) {
        console.error(`[ExtensionManager] 自定义编辑器 onDidDispose 回调出错：`, err);
      }
    }
    this.customEditorPanels.delete(panelKey);
    this.webviewHtml.delete(panelKey);
    this.resourceRoots.delete(panelKey);
  }

  /**
   * 落盘扩展提交的 `WorkspaceEdit`。
   *
   * 这是自定义编辑器「能改东西」的那一半。以前 shim 里 `applyEdit` 无条件返回 true ——
   * 对扩展说「改好了」，对用户说「什么都没发生」：Office Viewer 保存 markdown 走的
   * 就是这条路，静默丢改动是最糟的一种失败。
   *
   * 实现上按**文件**分组、同一文件内按位置**从后往前**应用：一条编辑会移动后面那些
   * 编辑的下标，倒着来才不用重新计算。只处理纯文本编辑；文件级操作（建/删/改名）
   * 也做，但只在真的指名到具体路径时 —— 拿不准就返回 false，让扩展知道失败。
   */
  private async applyWorkspaceEdit(edit: {
    textEdits?: {
      fsPath: string;
      startLine: number;
      startCharacter: number;
      endLine: number;
      endCharacter: number;
      newText: string;
    }[];
    fileOps?: { kind: 'create' | 'delete' | 'rename'; fsPath: string; newPath?: string }[];
  }): Promise<boolean> {
    const byFile = new Map<string, NonNullable<typeof edit.textEdits>>();
    for (const textEdit of edit.textEdits ?? []) {
      if (!textEdit?.fsPath) continue;
      const list = byFile.get(textEdit.fsPath) ?? [];
      list.push(textEdit);
      byFile.set(textEdit.fsPath, list);
    }

    try {
      for (const [filePath, edits] of byFile) {
        const original = await fs.readFile(filePath, 'utf8');
        // 偏移一律相对**原始内容**算，然后从后往前应用：一条编辑会移动它后面那些
        // 编辑的下标，倒着来就不用重新计算。
        const ranges = edits
          .map((textEdit) => ({
            start: offsetOf(original, {
              line: textEdit.startLine,
              character: textEdit.startCharacter,
            }),
            end: offsetOf(original, { line: textEdit.endLine, character: textEdit.endCharacter }),
            newText: textEdit.newText,
          }))
          .sort((a, b) => b.start - a.start);

        let next = original;
        for (const range of ranges) {
          if (range.start > range.end) continue;
          next = next.slice(0, range.start) + range.newText + next.slice(range.end);
        }
        if (next !== original) await fs.writeFile(filePath, next, 'utf8');
      }

      for (const op of edit.fileOps ?? []) {
        if (op.kind === 'create') await fs.writeFile(op.fsPath, '', { flag: 'a' });
        else if (op.kind === 'delete') await fs.rm(op.fsPath, { recursive: true, force: true });
        else if (op.kind === 'rename' && op.newPath) await fs.rename(op.fsPath, op.newPath);
      }

      // 文件变了要通知界面刷新：用户可能同时开着这个文件的文本标签
      for (const filePath of byFile.keys()) {
        this.broadcastToRenderers('fs:changed', { type: 'change', path: filePath });
      }
      return true;
    } catch (err: any) {
      console.error('[ExtensionManager] applyEdit 落盘失败：', err?.message ?? err);
      return false;
    }
  }

  /**
   * 获取已加载的扩展列表
   */
  getLoadedExtensions(): string[] {
    return this.extensionHost.getLoadedExtensions();
  }

  /**
   * 解析 WebviewView（返回 HTML 内容）
   */
  async resolveWebviewView(viewId: string): Promise<string> {
    /**
     * 面板的 HTML 是扩展自己塞进来的（`webview.html = …`），已经注入过运行时与主题，
     * 直接给渲染层用 —— 不需要（也没有）provider 可 resolve。
     */
    if (this.webviewPanels.has(viewId)) {
      return this.webviewHtml.get(viewId) ?? '';
    }

    const providerInfo = this.webviewViewProviders.get(viewId);
    if (!providerInfo) {
      throw new Error(`No WebviewView provider registered for: ${viewId}`);
    }

    const { provider } = providerInfo;

    /**
     * 重新解析一个视图 = 换了一份界面，**旧界面的消息回调必须先摘掉**。
     *
     * 不摘的后果不是「多收几条」那么轻：每个请求都会被投递 N 遍 —— 主进程日志里
     * 一次 `engine_ui_attach` 打出 6 条、`webview_focused` 打出 5 条就是这个。
     * 扩展那边于是会重复 attach、重复建会话，或者把重复的那几次当成冲突丢掉，
     * 表现出来是「点了没反应」这种最难查的样子（比如点「+」不新增会话）。
     *
     * `onDidReceiveMessage` 返回的 Disposable 会被扩展塞进 `context.subscriptions`，
     * 那是在**停用扩展**时才 dispose 的 —— 对「界面重开一次」这件事来说太晚了。
     */
    this.webviewMessageHandlers.delete(viewId);

    // 创建模拟的 webviewView 对象
    let htmlContent = '';
    let webviewOptions: any = {};

    const mockWebview = {
      get html() {
        return htmlContent;
      },
      set html(value: string) {
        htmlContent = value;
        console.log('[WebviewView] HTML set, length:', value?.length || 0);
      },
      get options() {
        return webviewOptions;
      },
      set options(value: any) {
        webviewOptions = value;
      },
      /**
       * 扩展注册「界面发回消息」的回调。
       *
       * 真实 Vitest 里 VS Code 会把 webview 的消息投递到这些回调；我们必须照做，
       * 否则面板能画出来但完全点不动（详见 deliverWebviewMessage）。
       */
      onDidReceiveMessage: (callback: (message: any) => void) => {
        let set = this.webviewMessageHandlers.get(viewId);
        if (!set) {
          set = new Set();
          this.webviewMessageHandlers.set(viewId, set);
        }
        set.add(callback);
        return {
          dispose: () => {
            set?.delete(callback);
          },
        };
      },
      /**
       * 扩展 → 界面。载荷原样转发给渲染进程，由它 postMessage 进访客页面。
       *
       * 注意**不能**在这里拆包：VS Code 的契约就是「postMessage 收到什么，页面
       * 的 message 事件 data 就是什么」，而扩展自己会包一层 `{type:'from-extension'}`。
       */
      postMessage: (message: any) => {
        this.broadcastToRenderers('extension:webview-message', {
          viewId,
          message: this.withPanelNewConversation(viewId, message),
        });
        return Promise.resolve(true);
      },
      /**
       * 扩展把自己目录里的文件变成界面可访问的地址。
       *
       * 返回 `echoly-webview://ext/<viewId>/<relPath>`，由本进程的协议处理器提供内容。
       * **不能**返回 `file://`：扩展的 bundle 是 module script，Chromium 禁止从
       * `file://` 加载它（Claude Code 的面板就是在这里报「index.js could not be fetched」）。
       */
      asWebviewUri: (uri: any) => {
        const fsPath = extractFsPath(uri);
        const root = this.webviewViewProviders.get(viewId)?.extensionPath ?? '';
        const relPath = root ? toWebviewResourcePath(root, fsPath) : '';
        const url = buildWebviewUrl(viewId, relPath);
        return url;
      },
      /**
       * 扩展把它拼进自己页面的 CSP（`style-src ${cspSource}` 之类）。
       *
       * 页面 origin 就是 `echoly-webview://ext`，所以 `'self'` 恰好等于「同源资源」——
       * 不必去编一个假的 cdn 主机名。CSP 只认这个场景，页面本身在 webview 里。
       */
      cspSource: buildWebviewOrigin(),
    };

    const mockWebviewView = {
      webview: mockWebview,
      viewType: viewId,
      title: undefined,
      description: undefined,
      visible: true,
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeVisibility: () => ({ dispose() {} }),
      show: () => {},
      badge: undefined,
    };

    // 调用提供者的 resolveWebviewView 方法
    if (typeof provider.resolveWebviewView === 'function') {
      try {
        await provider.resolveWebviewView(mockWebviewView, {}, { isCancellationRequested: false });
        htmlContent = mockWebview.html;
        console.log(
          `[resolveWebviewView] Final HTML length for ${viewId}: ${htmlContent?.length || 0}`,
        );

        // 这里**不再**改写扩展自己拼的地址。
        //
        // 以前那版把 Claude Code 的 `<script src>` 硬改成
        // `<extDir>/webview/index.js` 的 file:// 地址，而且扩展目录里写死了版本号
        // （`Anthropic.claude-code-2.1.234@darwin-arm64`）—— 既只对这一个扩展有用，
        // 又必然在某次升级后失效，最后的表现就是面板里一句
        // 「webview/index.js could not be fetched」。
        //
        // 现在扩展调 asWebviewUri 拿到的就是 echoly-webview:// 地址，协议处理器负责
        // 把文件端出去（含空格与 module script，见 extensionWebview.ts）。
        // 我们只需要做一件事：把 webview 运行时（acquireVsCodeApi）注入进去。

        // 把 webview 运行时（acquireVsCodeApi + 消息桥）注入进去
        htmlContent = this.injectRuntimeScript(htmlContent);

        // 主题变量当成一张样式表引进来（见 WEBVIEW_THEME_PATH 的注释）
        htmlContent = this.injectThemeLink(htmlContent, viewId);

        // 存进内存，等协议处理器按 `/index.html` 取。
        // 以前是写到 userData 再走 file://，那条路加载不了 module script（文件还留在磁盘上）。
        this.webviewHtml.set(viewId, htmlContent);
      } catch (err) {
        console.error(`Error resolving WebviewView ${viewId}:`, err);
        throw err;
      }
    }

    return htmlContent;
  }

  /**
   * 把「新会话开在面板里」这条语义补给 Claude 的**侧栏**界面。
   *
   * 背景：扩展用 `openNewInTab`（= 「这个界面是不是一个编辑器面板」）决定点「+」时
   * 干什么 —— 面板模式下发给扩展、开一个新标签；侧栏模式下则**就地新建一个会话**，
   * 于是当前对话被清空。我们的右侧面板渲染的就是侧栏那份界面，所以用户点「+」看到的
   * 是「没新增会话，当前窗口却被重置了」。
   *
   * 现在把发给这个界面的状态里的 `openNewInTab` 改成 true：点「+」会走
   * `claude-vscode.editor.open` → 扩展真正开一个 webview 面板 → 我们把它变成
   * 编辑器里的一个标签（见 createExtensionWebviewPanel）。侧栏本身不再被清空。
   *
   * 只动这一个布尔值，别的状态原样透传 —— Claude 的会话状态很脆，
   * 「顺手修正」别的字段迟早会踩到它。
   */
  private withPanelNewConversation(viewId: string, message: any): any {
    if (viewId !== CLAUDE_CODE_VIEW_ID) return message;
    const payload = message?.message;
    if (!payload || typeof payload !== 'object') return message;

    /**
     * 这份状态会在三条消息里出现（界面读的是同一个字段）：
     * - `request.update_state`（扩展主动推的）；
     * - `response.init_response`（界面 `init` 之后拿到的初始状态）；
     * - 以及极少数直接把 state 放在载荷顶层的形状。
     */
    const patch = (container: any): any => {
      const state = container?.state;
      if (!state || typeof state !== 'object' || state.openNewInTab === true) return container;
      return { ...container, state: { ...state, openNewInTab: true } };
    };

    const next: any = { ...payload };
    let changed = false;
    if (next.request) {
      const patched = patch(next.request);
      if (patched !== next.request) {
        next.request = patched;
        changed = true;
      }
    }
    if (next.response) {
      const patched = patch(next.response);
      if (patched !== next.response) {
        next.response = patched;
        changed = true;
      }
    }
    if (!next.request && !next.response) {
      const patched = patch(next);
      if (patched !== next) {
        Object.assign(next, patched);
        changed = true;
      }
    }
    return changed ? { ...message, message: next } : message;
  }

  /**
   * 扩展调 `window.createWebviewPanel`：真的把它变成一个编辑器标签。
   *
   * 和「视图」共用同一套协议与消息通道 —— 对一个 webview 来说，
   * 「谁开的」在协议层没有区别：一个 key、一份 HTML、一个资源根、一组回调。
   *
   * 时序：扩展先 new 面板、再设 `webview.html`（有的扩展也会先 postMessage）。
   * 所以「开标签」这件事发生在 setHtml 里，而不是这里 —— 这里只把 backend 交出去。
   */
  private createExtensionWebviewPanel(spec: {
    viewType: string;
    title: string;
    options?: any;
    extensionId?: string;
  }): import('@deepseek-ide/vscode-shim/src/index').WebviewPanelBackend {
    this.panelSeq += 1;
    // viewType 可能带点/斜杠（`claude-code.panel`），只保留 id 安全字符当命名空间
    const safeType = String(spec.viewType || 'panel').replace(/[^A-Za-z0-9_.-]/g, '_');
    const panelId = `panel:${safeType}:${this.panelSeq}`;
    const title = spec.title || 'Extension';

    this.webviewPanels.set(panelId, { title, viewType: spec.viewType });
    // 面板的资源一律走 `-/abs/`（见 PANEL_ROOT_SENTINEL 的注释）
    this.resourceRoots.set(panelId, ExtensionManager.PANEL_ROOT_SENTINEL);

    return {
      panelId,
      cspSource: buildWebviewOrigin(),
      setHtml: (html: string) => {
        // 与视图同源：注入 webview 运行时（acquireVsCodeApi）与主题表
        const withRuntime = this.injectThemeLink(this.injectRuntimeScript(html ?? ''), panelId);
        this.webviewHtml.set(panelId, withRuntime);
        this.broadcastToRenderers('extension:webview-registered', { viewId: panelId });
        // 渲染层收到这条就开一个编辑器标签，标签里是上面这份 HTML
        this.broadcastToRenderers('extension:panel-opened', {
          panelId,
          title,
          viewType: spec.viewType,
        });
      },
      asWebviewUri: (uri: any) => {
        // 面板拿不到扩展目录，用绝对路径形式（协议处理器单独放行）
        return buildWebviewUrl(panelId, toAbsWebviewResourcePath(extractFsPath(uri)));
      },
      postMessage: (message: any) => {
        this.broadcastToRenderers('extension:webview-message', { viewId: panelId, message });
        return true;
      },
      reveal: () => {
        this.broadcastToRenderers('extension:panel-revealed', { panelId });
      },
      dispose: () => {
        this.webviewPanels.delete(panelId);
        this.webviewHtml.delete(panelId);
        this.resourceRoots.delete(panelId);
        this.webviewMessageHandlers.delete(panelId);
        this.broadcastToRenderers('extension:panel-closed', { panelId });
      },
    };
  }

  /**
   * 把 webview 运行时（`acquireVsCodeApi` + 消息桥）注入扩展页面。
   *
   * VS Code 里这个函数由 webview 宿主运行时提供，不是扩展自己的代码 —— 少了它
   * 扩展的 bundle 一上来就 `acquireVsCodeApi is not defined`。nonce 必须与扩展页面
   * 自己的 CSP `script-src 'nonce-…'` 对上，所以 nonce 从它那儿取。
   *
   * 插在第一个 nonce script **之前**：扩展自己的脚本可能在很靠前的位置同步读
   * `window.CLAUDE_PANEL_STARTED` 之类的全局量，晚一步就白搭。
   */
  private injectRuntimeScript(html: string): string {
    const nonceMatch = html.match(/nonce-([a-f0-9]+)/);
    const runtimeScript = this.buildWebviewRuntimeScript(nonceMatch ? nonceMatch[1] : '');
    const firstScriptMatch = html.match(/<script[^>]*nonce/);
    if (firstScriptMatch) {
      return html.replace(firstScriptMatch[0], `${runtimeScript}\n    ${firstScriptMatch[0]}`);
    }
    return html.replace('</head>', `${runtimeScript}</head>`);
  }

  /**
   * 注入给扩展页面的最小 webview 运行时。
   *
   * 两件事：
   * 1. `acquireVsCodeApi()` —— 扩展的 bundle 一上来就调它，没有就整个挂掉；
   * 2. 接上消息桥的两端：
   *    - 出：页面 `postMessage` → 访客 preload → 渲染进程 → 主进程 → 扩展的 onDidReceiveMessage；
   *    - 入：扩展 `postMessage` → 主进程 → 渲染进程 → 页面里的一个 message 事件。
   */
  private buildWebviewRuntimeScript(nonce: string): string {
    return `
<script nonce="${nonce}">
(function() {
  var bridge = window.__echolyWebviewBridge;
  var state = {};

  // 宿主 → 页面。用 window.postMessage 而不是 new MessageEvent：
  // 扩展页面里那层包装会检查 event.source 是不是自己的祖先窗口（Claude Code 用它的
  // sBn() 做这件事）。window.postMessage 派发出来的 source 正好是 window 自己，能过；
  // 手动构造的 MessageEvent 的 source 是 null，会被它当成别的窗口的消息丢掉。
  if (bridge && typeof bridge.onMessage === 'function') {
    bridge.onMessage(function(data) { window.postMessage(data, '*'); });
  }

  window.acquireVsCodeApi = function() {
    return {
      postMessage: function(message) {
        if (bridge && typeof bridge.post === 'function') bridge.post(message);
        else console.warn('[echoly] webview 消息桥不可用，这条消息被丢弃：', message);
      },
      getState: function() { return state; },
      setState: function(next) { state = next; return state; }
    };
  };
})();
</script>`;
  }

  /**
   * 处理扩展发送的命令
   */
  /**
   * 扩展 → 用户的一条提示（`window.show{Information,Warning,Error}Message`）。
   *
   * 广播给渲染层弹 toast。以前这三个方法只往 `onMessage` 丢一条消息，而渲染层
   * **没人听** —— 扩展说「保存失败」「这个文件没有权限」全都石沉大海。
   */
  private notifyRenderer(level: 'info' | 'warning' | 'error', message: string): void {
    console.log(`[extension:notify] ${level}: ${message}`);
    this.broadcastToRenderers('extension:notify', { level, message });
  }

  /**
   * 扩展要的「打开文件」对话框。
   *
   * 返回 `fsPath` 数组（官方形状），用户取消时返回 undefined —— 那是正常语义，
   * 不是错误。过滤器要先把官方的 `{Images: ['png']}` 翻成 electron 的
   * `{name, extensions}`，翻错的表现是「对话框里什么都选不了」。
   */
  private async showOpenDialog(options: any): Promise<string[] | undefined> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return undefined;
    const filters = toElectronFilters(options?.filters);
    const result = await dialog.showOpenDialog(win, {
      title: options?.title,
      defaultPath: options?.defaultUri?.fsPath,
      properties: [
        options?.canSelectMany ? 'multiSelections' : 'openFile',
        ...(options?.canSelectFolders ? (['openDirectory'] as const) : []),
        ...(options?.canSelectFiles === false && !options?.canSelectFolders
          ? ([] as const)
          : ([] as const)),
      ] as any,
      filters: filters.length > 0 ? filters : undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    return result.filePaths;
  }

  /** 扩展要的「保存到哪」对话框。返回 fsPath。 */
  private async showSaveDialog(options: any): Promise<string | undefined> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return undefined;
    const filters = toElectronFilters(options?.filters);
    const result = await dialog.showSaveDialog(win, {
      title: options?.title,
      defaultPath: options?.defaultUri?.fsPath,
      filters: filters.length > 0 ? filters : undefined,
    });
    return result.canceled || !result.filePath ? undefined : result.filePath;
  }

  /**
   * 扩展要的「选一个」。
   *
   * 用系统消息框的按钮凑：`showQuickPick` 在扩展里绝大多数是「是/否」这种确认
   * （Office Viewer 的 `confirm` 就是），按钮语义完全对得上。
   * 返回**原样的 item**（官方就是这个语义），取消返回 undefined。
   */
  private async showQuickPick(items: any[], options?: any): Promise<any> {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || items.length === 0) return undefined;
    const labels = items.map((item) => String(item?.label ?? item));
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: options?.title,
      message: options?.placeHolder || options?.title || labels[0],
      buttons: labels.slice(0, 6),
      cancelId: -1,
      noLink: true,
    });
    if (result.response < 0 || result.response >= items.length) return undefined;
    return items[result.response];
  }

  /** 用系统浏览器打开链接。以前 `env.openExternal` 返回 true 却什么都没做。 */
  private async openExternal(url: string): Promise<boolean> {
    if (!/^https?:/i.test(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch (err) {
      console.error('[extension] openExternal 失败：', err);
      return false;
    }
  }

  /**
   * 扩展执行命令。
   *
   * 分三种去处，不能一概「广播就完事」：
   * 1. **主进程自己能做的**（开发者工具、在文件管理器里显示）就地做掉；
   * 2. **编辑器的事**（保存、打开某个文件）广播给渲染层 —— 只有它知道标签与缓冲区；
   * 3. 其余的广播出去（命令面板 / 未来的快捷键都能接）。
   *
   * Office Viewer 的工具栏按钮几乎全落在这三类里：保存、导出后保存、
   * 「用 VS Code 编辑」（`vscode.openWith`）、`revealFileInOS`。
   * 以前一律只是广播，而**渲染层没人听** —— 点下去自然毫无反应。
   */
  private async handleCommand(command: string, ...args: any[]): Promise<any> {
    console.log(`Extension command: ${command}`, args);

    if (command === 'workbench.action.toggleDevTools') {
      BrowserWindow.getAllWindows()[0]?.webContents.toggleDevTools();
      return undefined;
    }
    if (command === 'revealFileInOS') {
      const target = args[0]?.fsPath ?? args[0];
      if (typeof target === 'string') shell.showItemInFolder(target);
      return undefined;
    }

    // 将命令广播到所有渲染进程
    this.broadcastToRenderers('extension:command', { command, args });

    // TODO: 实现具体的命令处理逻辑
    return undefined;
  }

  /**
   * 处理扩展发送的消息
   */
  private handleMessage(message: any): void {
    console.log('Extension message:', message);

    // 转发消息给注册的处理器
    this.messageHandlers.forEach((handler) => {
      try {
        handler(message);
      } catch (err) {
        console.error('Error in message handler:', err);
      }
    });

    // 广播到渲染进程
    this.broadcastToRenderers('extension:message', message);
  }

  /**
   * 处理 WebviewView 提供者注册
   */
  private handleWebviewViewRegister(
    viewId: string,
    provider: any,
    extensionPath: string,
    options?: any,
    extensionId?: string,
  ): void {
    console.log(
      `[ExtensionManager] WebviewView provider registered: ${viewId}, extensionPath: ${extensionPath}`,
    );
    if (extensionId) this.viewOwners.set(viewId, extensionId);
    // 重新注册同一个 viewId（重装/重启扩展）时先丢掉上一份 HTML：留着的话
    // 界面会渲染上一个版本生成的那份，而里面的资源地址已经对不上了。
    this.webviewHtml.delete(viewId);
    this.webviewViewProviders.set(viewId, { provider, options, extensionPath });
    // 资源根目录：协议处理器按它把这边的文件端出去
    this.resourceRoots.set(viewId, extensionPath);

    // 通知渲染进程有新的 webview 可用
    this.broadcastToRenderers('extension:webview-registered', { viewId });
  }

  /**
   * 注册 IPC 处理器
   */
  private registerIpcHandlers(): void {
    // 安装 Claude Code 扩展
    ipcMain.handle('extension:install-claude-code', async () => {
      try {
        await this.installClaudeCodeExtension();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // 市场搜索
    ipcMain.handle('extension:marketplace-search', async (_event, query: string, size?: number) => {
      return await this.searchMarketplace(query ?? '', size ?? 20);
    });

    // 推荐列表（热门扩展）
    ipcMain.handle('extension:marketplace-recommended', async (_event, size?: number) => {
      return await this.getRecommendedExtensions(size);
    });

    // 扩展详情（含 README）
    ipcMain.handle('extension:detail', async (_event, id: string) => {
      return await this.getExtensionDetail(id);
    });

    // 扩展图标（主进程代理抓取，见 getIconDataUrl）
    ipcMain.handle('extension:icon-data-url', async (_event, iconUrl: string) => {
      return await this.getIconDataUrl(iconUrl);
    });

    // 从市场安装
    ipcMain.handle(
      'extension:install-from-marketplace',
      async (
        _event,
        extension: { id: string; downloadUrl: string; version?: string; displayName?: string },
      ) => {
        try {
          const { warning } = await this.installFromMarketplace(extension);
          return { success: true, ...(warning ? { warning } : {}) };
        } catch (err: any) {
          return { success: false, error: err.message };
        }
      },
    );

    // 从路径加载扩展
    ipcMain.handle('extension:load-from-path', async (_event, extensionPath: string) => {
      try {
        await this.loadExtensionFromPath(extensionPath);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // 执行扩展命令
    ipcMain.handle('extension:execute-command', async (_event, command: string, ...args: any[]) => {
      try {
        const result = await this.executeCommand(command, ...args);
        return { success: true, result };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // 获取已加载的扩展
    ipcMain.handle('extension:get-loaded', async () => {
      return { success: true, extensions: this.getLoadedExtensions() };
    });

    // 已安装扩展的登记表（带版本 / 启用状态 / 贡献的命令与视图）
    ipcMain.handle('extension:list-installed', async () => {
      try {
        return { success: true, extensions: await this.listInstalledExtensions() };
      } catch (err: any) {
        return { success: false, error: err.message, extensions: [] };
      }
    });

    // 所有扩展贡献的命令（命令面板据此列出「扩展命令」）
    ipcMain.handle('extension:list-commands', async () => {
      try {
        return { success: true, commands: await this.listExtensionCommands() };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err), commands: [] };
      }
    });

    // 启用 / 禁用
    ipcMain.handle('extension:set-enabled', async (_event, id: string, enabled: boolean) => {
      return await this.setExtensionEnabled(id, enabled);
    });

    // 卸载
    ipcMain.handle('extension:uninstall', async (_event, id: string) => {
      return await this.uninstallExtension(id);
    });

    // 解析 WebviewView：生成 HTML 并给出它在 echoly-webview:// 下的地址
    ipcMain.handle('extension:resolve-webview', async (_event, viewId: string) => {
      try {
        await this.resolveWebviewView(viewId);
        return {
          success: true,
          // url 是 `<webview src>` 要用的；preload 是访客侧的脚本（消息桥的一半），
          // 它的位置只有主进程知道，所以一并给渲染进程。
          url: this.getWebviewUrl(viewId),
          preloadUrl: this.getWebviewPreloadUrl(),
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    // 这个文件该不该交给扩展的自定义编辑器（打开文件前问一次）
    ipcMain.handle('extension:custom-editor-match', async (_event, filePath: string) => {
      try {
        const candidate = await this.matchCustomEditor(filePath);
        return {
          success: true,
          match: candidate
            ? {
                viewType: candidate.viewType,
                extensionId: candidate.extensionId,
                displayName: candidate.displayName,
              }
            : null,
          /**
           * 「本该由它渲染，但它被禁用了」。
           *
           * 没有这一条，用户看到的就是「装了 Office Viewer 却一直用内置编辑器」，
           * 而且**永远猜不到**原因是我们把那个扩展禁用过 —— 界面上不会给任何提示。
           */
          disabledClaimant: candidate ? undefined : await this.findDisabledClaimant(filePath),
        };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err), match: null };
      }
    });

    // 所有能被路由的自定义编辑器（详情页列「能接手哪些文件」用）
    ipcMain.handle('extension:custom-editors', async () => {
      try {
        return { success: true, editors: await this.listCustomEditors() };
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err), editors: [] };
      }
    });

    // 打开一个自定义编辑器（建面板 + 调扩展的 resolve）
    ipcMain.handle('extension:custom-editor-open', async (_event, filePath: string) => {
      return await this.openCustomEditor(filePath);
    });

    // 界面里的操作 → 扩展
    ipcMain.handle(
      'extension:custom-editor-post',
      async (_event, panelKey: string, message: any) => {
        this.deliverCustomEditorMessage(panelKey, message);
        return { success: true };
      },
    );

    // 关标签时释放面板（扩展的 onDidDispose 要跑）
    ipcMain.handle('extension:custom-editor-dispose', async (_event, panelKey: string) => {
      this.disposeCustomEditor(panelKey);
      return { success: true };
    });

    // 关掉扩展 webview 面板的标签：要触发扩展的 `panel.onDidDispose`，
    // 否则扩展会一直以为「这个会话已经开在某个面板里」，之后再点什么都不发生。
    ipcMain.handle('extension:dispose-panel', async (_event, panelId: string) => {
      return { success: this.extensionHost.disposePanel(panelId) };
    });

    // 渲染进程推主题变量（`:root` 上的实际值只有它有）
    ipcMain.handle('extension:set-webview-theme', async (_event, vars: Record<string, string>) => {
      this.setWebviewTheme(vars ?? {});
      return { success: true };
    });

    // 扩展界面里的用户操作 → 扩展的 onDidReceiveMessage
    ipcMain.handle('extension:webview-post', async (_event, viewId: string, message: any) => {
      try {
        this.deliverWebviewMessage(viewId, message);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * 广播消息到所有渲染进程
   */
  private broadcastToRenderers(channel: string, data: any): void {
    // 用顶部的 import，而不是函数里再 require('electron')：
    // 后者在测试里绕不过 vi.mock('electron')，一条广播就能把整条链路带崩。
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(channel, data);
    }
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    await this.extensionHost.dispose();
    this.messageHandlers.clear();
    this.webviewHtml.clear();
    this.webviewMessageHandlers.clear();
    this.resourceRoots.clear();
    this.webviewPanels.clear();
    this.webviewHtml.clear();
    for (const panelKey of Array.from(this.customEditorPanels.keys())) {
      this.disposeCustomEditor(panelKey);
    }
    for (const target of [
      session.defaultSession.protocol,
      session.fromPartition(EXTENSION_WEBVIEW_PARTITION).protocol,
    ]) {
      try {
        target.unhandle(EXTENSION_WEBVIEW_SCHEME);
      } catch {
        // 没注册过 / 已经摘掉了：都不是问题
      }
    }
  }
}

// 全局扩展管理器实例
let globalExtensionManager: ExtensionManager | null = null;

/**
 * 获取全局扩展管理器
 */
export function getExtensionManager(): ExtensionManager | null {
  return globalExtensionManager;
}

/**
 * 初始化全局扩展管理器
 */
export async function initializeExtensionManager(
  options: ExtensionManagerOptions,
): Promise<ExtensionManager> {
  if (globalExtensionManager) {
    throw new Error('Extension Manager already initialized');
  }

  globalExtensionManager = new ExtensionManager(options);
  await globalExtensionManager.initialize();
  return globalExtensionManager;
}

/**
 * 清理全局扩展管理器
 */
export async function disposeExtensionManager(): Promise<void> {
  if (globalExtensionManager) {
    await globalExtensionManager.dispose();
    globalExtensionManager = null;
  }
}
