/**
 * Extension Manager for Electron Main Process
 * 管理 VSCode 扩展的加载、激活和通信
 */

import { ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { app } from 'electron';
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
  buildReadmeUrl,
  buildRecommendedUrl,
  buildSearchUrl,
  isAllowedIconUrl,
  isPlatformAgnosticDownload,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxDetail,
  parseOpenVsxSearch,
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

/** README 抓取上限：详情页是展示用的，没必要为一个说明文件拉几百 KB。 */
const maxReadmeBytes = 512 * 1024;
const maxReadmeChars = 200_000;
const readmeFetchTimeoutMs = 10_000;

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

  constructor(options: ExtensionManagerOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.registry = normalizeRegistryBase(options.registry);
    this.extensionsDir = path.join(app.getPath('userData'), 'extensions');

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

    // 注册 IPC 处理器
    this.registerIpcHandlers();

    console.log(`Extension Manager initialized. Extensions dir: ${this.extensionsDir}`);

    // 自动加载所有已安装的扩展
    await this.loadInstalledExtensions();
  }

  /**
   * 自动加载已安装的扩展
   */
  private async loadInstalledExtensions(): Promise<void> {
    try {
      const entries = await fs.readdir(this.extensionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const extensionPath = path.join(this.extensionsDir, entry.name, 'extension');

          // 检查是否有 extension 子目录（.vsix 解压后的结构）
          try {
            await fs.access(path.join(extensionPath, 'package.json'));
            console.log(`Auto-loading extension: ${entry.name}`);

            // 异步加载，不阻塞启动
            this.loadExtensionFromPath(extensionPath).catch((err) => {
              console.error(`Failed to auto-load extension ${entry.name}:`, err.message);
            });
          } catch {
            // 没有 extension 子目录，跳过
          }
        }
      }
    } catch (err) {
      console.error('Failed to scan extensions directory:', err);
    }
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
   * 地址是从**校验过的 id 与版本号**拼出来的，不是从渲染层传进来的任意 URL ——
   * 这个方法是主进程代渲染层发请求，能抓什么必须由这里说了算。
   * 注册表会 302 到这个文件的 CDN，所以这里跟随重定向（fetch 默认行为）；
   * 能跳到哪去由配置的注册表决定，属于用户自己的信任边界。
   */
  private async fetchReadme(detail: MarketplaceExtension): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), readmeFetchTimeoutMs);
    try {
      const res = await fetch(buildReadmeUrl(this.registry, detail.id, detail.version), {
        signal: controller.signal,
      });
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
    const vsixPath = path.join(this.extensionsDir, `${extension.id}.vsix`);
    const extractDir = path.join(this.extensionsDir, extension.id);

    // 进度必须带上是**哪个**扩展：面板里可以同时装好几个，
    // 一条不带身份的「正在下载…」等于没说。
    const progressId = { id: extension.id, name: extension.displayName || extension.id };
    try {
      await downloadVsix(extension.downloadUrl, vsixPath, (progress) => {
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
      return {};
    } catch (err: any) {
      console.warn(`[ExtensionManager] ${extension.id} 已安装但激活失败：`, err);
      return { warning: `已安装，但激活失败：${err?.message ?? err}` };
    }
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
      onDidReceiveMessage: (callback: any) => {
        // 返回 Disposable
        return { dispose() {} };
      },
      postMessage: (message: any) => {
        console.log('[WebviewView] postMessage:', message);
        // 这里可以将消息转发到渲染进程
        this.broadcastToRenderers('extension:webview-message', { viewId, message });
        return Promise.resolve(true);
      },
      asWebviewUri: (uri: any) => {
        // 将 VSCode URI 转换为 file:// URL
        // uri 可能是字符串或对象，需要提取路径
        let filePath: string;
        if (typeof uri === 'string') {
          filePath = uri;
        } else if (uri && typeof uri === 'object') {
          filePath = uri.fsPath || uri.path || String(uri);
        } else {
          filePath = String(uri);
        }

        // 确保路径是绝对路径
        if (!filePath.startsWith('/')) {
          // 如果是相对路径，拼接扩展目录
          const providerInfo = this.webviewViewProviders.get(viewId);
          if (providerInfo && providerInfo.extensionPath) {
            filePath = require('path').join(providerInfo.extensionPath, filePath);
          }
        }

        // 转换为 file:// URL
        const fileUrl = `file://${filePath}`;
        console.log('[asWebviewUri] Convert:', uri, '->', fileUrl);
        return fileUrl;
      },
      cspSource: 'self',
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

        // 修复 Claude 扩展的资源路径
        // 将 <link href="file:///.../extension" 替换为 file:///.../extension/webview/index.css
        // 将 <script src="file:///.../extension" 替换为 file:///.../extension/webview/index.js
        const path = require('path');
        const extensionDirPath = path.join(
          providerInfo.extensionPath,
          'extensions',
          'Anthropic.claude-code-2.1.234@darwin-arm64',
          'extension',
        );
        const extensionDirUrl = `file://${extensionDirPath}`;

        console.log(`[resolveWebviewView] Fixing resource paths for: ${extensionDirUrl}`);

        // 替换 link 标签
        htmlContent = htmlContent.replace(
          new RegExp(
            `<link([^>]*?)href="${extensionDirUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"([^>]*?)>`,
            'g',
          ),
          `<link$1href="file://${extensionDirPath}/webview/index.css"$2>`,
        );

        // 替换 script 标签
        htmlContent = htmlContent.replace(
          new RegExp(
            `<script([^>]*?)src="${extensionDirUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"([^>]*?)>`,
            'g',
          ),
          `<script$1src="file://${extensionDirPath}/webview/index.js"$2>`,
        );

        console.log(
          `[resolveWebviewView] HTML after path fix, length: ${htmlContent?.length || 0}`,
        );

        // 提取 nonce 值
        const nonceMatch = htmlContent.match(/nonce-([a-f0-9]+)/);
        const nonce = nonceMatch ? nonceMatch[1] : '';
        console.log(`[resolveWebviewView] Extracted nonce: ${nonce}`);

        // 注入 VSCode webview API（使用相同的 nonce）
        const vscodeApiScript = `
<script nonce="${nonce}">
(function() {
  let state = {};
  window.acquireVsCodeApi = function() {
    return {
      postMessage: function(message) {
        console.log('[VSCode API] postMessage:', message);
        // TODO: 通过 IPC 转发消息到扩展
        window.parent.postMessage(message, '*');
      },
      getState: function() {
        return state;
      },
      setState: function(newState) {
        state = newState;
        return newState;
      }
    };
  };
  console.log('[VSCode API] acquireVsCodeApi injected');
})();
</script>`;

        // 在第一个 script 标签前注入 API（确保最先执行）
        const firstScriptMatch = htmlContent.match(/<script[^>]*nonce/);
        if (firstScriptMatch) {
          htmlContent = htmlContent.replace(
            firstScriptMatch[0],
            `${vscodeApiScript}\n    ${firstScriptMatch[0]}`,
          );
        } else {
          // 如果找不到 script 标签，就在 head 结束前注入
          htmlContent = htmlContent.replace('</head>', `${vscodeApiScript}</head>`);
        }

        // 调试：保存 HTML 并打印预览
        console.log(
          `[resolveWebviewView] HTML preview:\n${htmlContent.substring(0, 500)}\n...\n${htmlContent.substring(Math.max(0, htmlContent.length - 200))}`,
        );

        try {
          const fs = require('fs');
          const { app } = require('electron');
          const tmpPath = path.join(app.getPath('userData'), `webview-${viewId}.html`);
          fs.writeFileSync(tmpPath, htmlContent, 'utf8');
          console.log(`[resolveWebviewView] HTML saved to: ${tmpPath}`);
        } catch (err) {
          console.error('[resolveWebviewView] Failed to save HTML:', err);
        }
      } catch (err) {
        console.error(`Error resolving WebviewView ${viewId}:`, err);
        throw err;
      }
    }

    return htmlContent;
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
  ): void {
    console.log(
      `[ExtensionManager] WebviewView provider registered: ${viewId}, extensionPath: ${extensionPath}`,
    );
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

    // 解析 WebviewView
    ipcMain.handle('extension:resolve-webview', async (_event, viewId: string) => {
      try {
        const html = await this.resolveWebviewView(viewId);
        // 返回真实写入路径（渲染进程不应硬编码 userData 目录）
        const filePath = path.join(app.getPath('userData'), `webview-${viewId}.html`);
        return { success: true, html, filePath };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });
  }

  /**
   * 广播消息到所有渲染进程
   */
  private broadcastToRenderers(channel: string, data: any): void {
    const { BrowserWindow } = require('electron');
    BrowserWindow.getAllWindows().forEach((window: any) => {
      window.webContents.send(channel, data);
    });
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    await this.extensionHost.dispose();
    this.messageHandlers.clear();
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
