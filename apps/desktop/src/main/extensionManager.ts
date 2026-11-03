/**
 * Extension Manager for Electron Main Process
 * 管理 VSCode 扩展的加载、激活和通信
 */

import { BrowserWindow, ipcMain, net, protocol, session } from 'electron';
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
  toWebviewResourcePath,
} from './extensionWebview';
import { ExtensionHost } from '@deepseek-ide/vscode-shim/src/extensionHost';
import {
  loadExtension,
  loadExtensionFromVsix,
  downloadClaudeCodeExtension,
  downloadVsix,
  type LoadedExtension,
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
    });

    // 把 `vscode` 模块落到扩展目录旁（ESM 扩展只能靠真模块解析，require 补丁拦不住）。
    // 在构造时就发起，但真正等它的是 ensureVscodeShim —— 安装/加载扩展前都会 await 一次，
    // 免得「刚好在写盘那一刻点安装」这种竞态。
    this.vscodeShimReady = this.ensureVscodeShim();
  }

  /**
   * 初始化扩展管理器
   */
  async initialize(): Promise<void> {
    // 确保扩展目录存在
    await fs.mkdir(this.extensionsDir, { recursive: true });

    // 先读禁用列表，再扫目录：不然被禁用的扩展会在启动时被加载一遍
    await this.loadDisabledState();

    // 注册 IPC 处理器
    this.registerIpcHandlers();

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

    const providerInfo = this.webviewViewProviders.get(viewId);
    if (!providerInfo) {
      return new Response(`no provider for view "${viewId}"`, {
        status: 404,
        headers: TEXT_PLAIN_HEADERS,
      });
    }

    const filePath = resolveWebviewFilePath(providerInfo.extensionPath, relPath);
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
    try {
      // 用扫描结果而不是裸 readdir：判「有没有被禁用」要用扩展 id，
      // 而目录名可能是 `claude-code` 这种和 id 对不上的名字。
      for (const record of await this.scanInstalledDirs()) {
        if (this.disabledExtensions.has(record.id) || this.disabledExtensions.has(record.dir)) {
          console.log(`Skipping disabled extension: ${record.id}`);
          continue;
        }
        console.log(`Auto-loading extension: ${record.id}`);
        // 异步加载，不阻塞启动
        this.loadExtensionFromPath(path.join(this.extensionsDir, record.dir, 'extension')).catch(
          (err) => {
            console.error(`Failed to auto-load extension ${record.id}:`, err.message);
          },
        );
      }
    } catch (err) {
      console.error('Failed to scan extensions directory:', err);
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
    const providerInfo = this.webviewViewProviders.get(viewId);
    if (!providerInfo) {
      throw new Error(`No WebviewView provider registered for: ${viewId}`);
    }

    const { provider } = providerInfo;

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
        this.broadcastToRenderers('extension:webview-message', { viewId, message });
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

        // 把 webview 运行时（acquireVsCodeApi）注入进去。
        //
        // VS Code 里这个函数由 webview 宿主运行时提供，不是扩展自己的代码 —— 少了它
        // 扩展的 bundle 一上来就 `acquireVsCodeApi is not defined`。nonce 必须与
        // 扩展页面自己的 CSP `script-src 'nonce-...'` 对上，所以 nonce 从它那儿取。
        const nonceMatch = htmlContent.match(/nonce-([a-f0-9]+)/);
        const nonce = nonceMatch ? nonceMatch[1] : '';
        const runtimeScript = this.buildWebviewRuntimeScript(nonce);

        // 插在第一个 nonce script 之前：扩展自己的脚本可能会在很靠前的位置同步读
        // window.CLAUDE_PANEL_STARTED 之类的全局量，晚一步就白搭。
        const firstScriptMatch = htmlContent.match(/<script[^>]*nonce/);
        if (firstScriptMatch) {
          htmlContent = htmlContent.replace(
            firstScriptMatch[0],
            `${runtimeScript}\n    ${firstScriptMatch[0]}`,
          );
        } else {
          htmlContent = htmlContent.replace('</head>', `${runtimeScript}</head>`);
        }

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
  private async handleCommand(command: string, ...args: any[]): Promise<any> {
    console.log(`Extension command: ${command}`, args);

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
