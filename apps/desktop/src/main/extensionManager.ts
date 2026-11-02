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
  buildSearchUrl,
  isSafeExtensionId,
  normalizeRegistryBase,
  parseOpenVsxSearch,
  type MarketplaceExtension,
} from '@deepseek-ide/vscode-shim/src/openVsx';

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
        // 广播下载进度到所有渲染进程
        this.broadcastToRenderers('extension:download-progress', progress);
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
  }): Promise<void> {
    if (!isSafeExtensionId(extension.id)) {
      throw new Error(`扩展 id 不合法，已拒绝安装：${extension.id}`);
    }
    if (!/^https?:\/\//i.test(extension.downloadUrl ?? '')) {
      throw new Error('下载地址不合法（必须是 http/https）');
    }

    const vsixPath = path.join(this.extensionsDir, `${extension.id}.vsix`);
    const extractDir = path.join(this.extensionsDir, extension.id);

    await downloadVsix(extension.downloadUrl, vsixPath, (progress) => {
      this.broadcastToRenderers('extension:download-progress', progress);
    });

    const loaded = await loadExtensionFromVsix(vsixPath, extractDir);
    await this.extensionHost.activateExtension(loaded);
    this.loadedExtensionPaths.add(path.join(extractDir, 'extension'));

    console.log(
      `[ExtensionManager] 已从市场安装并激活：${extension.id} v${loaded.manifest.version}`,
    );
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

    // 从市场安装
    ipcMain.handle(
      'extension:install-from-marketplace',
      async (_event, extension: { id: string; downloadUrl: string; version?: string }) => {
        try {
          await this.installFromMarketplace(extension);
          return { success: true };
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
