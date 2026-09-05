/**
 * Extension Host
 * 在独立进程中运行 VSCode 扩展
 */

import { VSCodeShim, ExtensionContext, createExtensionContext } from './index';
import { LoadedExtension } from './extensionLoader';

export interface ExtensionHostOptions {
  workspaceRoot: string;
  onCommand: (command: string, ...args: any[]) => Promise<any>;
  onMessage: (message: any) => void;
  onWebviewViewRegister?: (viewId: string, provider: any, extensionPath: string, options?: any) => void;
}

export class ExtensionHost {
  private shim: VSCodeShim;
  private loadedExtensions: Map<string, LoadedExtension> = new Map();
  private extensionContexts: Map<string, ExtensionContext> = new Map();

  constructor(options: ExtensionHostOptions) {
    this.shim = new VSCodeShim({
      workspaceRoot: options.workspaceRoot,
      extensionPath: options.workspaceRoot,
      onCommand: options.onCommand,
      onMessage: options.onMessage,
      onWebviewViewRegister: options.onWebviewViewRegister,
    });
    
    // 立即注入 vscode 模块到全局，确保任何扩展 require('vscode') 时都能找到
    const vscodeAPI = this.shim.createAPI();
    this.injectVscodeModule(vscodeAPI);
    this.injectWindowPolyfills();
    console.log('[ExtensionHost] VSCode 模块已全局注入');
  }

  /**
   * 加载并激活扩展
   */
  async activateExtension(extension: LoadedExtension): Promise<void> {
    const extensionId = `${extension.manifest.publisher}.${extension.manifest.name}`;
    
    console.log(`[activateExtension] 开始激活扩展: ${extensionId}`);

    // 创建扩展上下文
    console.log(`[activateExtension] 创建扩展上下文...`);
    const context = createExtensionContext(extension.extensionPath);
    this.extensionContexts.set(extensionId, context);

    // 保存扩展信息
    this.loadedExtensions.set(extensionId, extension);
    console.log(`[activateExtension] 扩展信息已保存`);

    // 调用扩展的 activate 函数（vscode 模块已在构造函数中全局注入）
    if (extension.mainModule && typeof extension.mainModule.activate === 'function') {
      try {
        console.log(`[activateExtension] 调用 activate() 函数...`);
        await extension.mainModule.activate(context);
        console.log(`[activateExtension] Extension ${extensionId} activated successfully`);
      } catch (err) {
        console.error(`[activateExtension] Failed to activate extension ${extensionId}:`, err);
        throw err;
      }
    } else {
      console.warn(`[activateExtension] Extension ${extensionId} has no activate function`);
    }
    
    console.log(`[activateExtension] 扩展激活流程完成`);
  }

  /**
   * 停用扩展
   */
  async deactivateExtension(extensionId: string): Promise<void> {
    const extension = this.loadedExtensions.get(extensionId);
    if (!extension) {
      return;
    }

    console.log(`Deactivating extension: ${extensionId}`);

    // 调用扩展的 deactivate 函数
    if (extension.mainModule && typeof extension.mainModule.deactivate === 'function') {
      try {
        await extension.mainModule.deactivate();
      } catch (err) {
        console.error(`Error deactivating extension ${extensionId}:`, err);
      }
    }

    // 清理订阅
    const context = this.extensionContexts.get(extensionId);
    if (context) {
      context.subscriptions.forEach((sub) => {
        try {
          sub.dispose();
        } catch (err) {
          console.error(`Error disposing subscription:`, err);
        }
      });
    }

    this.loadedExtensions.delete(extensionId);
    this.extensionContexts.delete(extensionId);
  }

  /**
   * 执行命令
   */
  async executeCommand(command: string, ...args: any[]): Promise<any> {
    return this.shim.executeCommand(command, ...args);
  }

  /**
   * 获取已加载的扩展列表
   */
  getLoadedExtensions(): string[] {
    return Array.from(this.loadedExtensions.keys());
  }

  /**
   * 注入 vscode 模块到 require 系统
   */
  private injectVscodeModule(vscodeAPI: any): void {
    // 方法1：修改 require.cache
    const Module = require('module');
    Module._cache['vscode'] = {
      id: 'vscode',
      filename: 'vscode',
      loaded: true,
      exports: vscodeAPI,
    };
    
    // 方法2：拦截 require 调用
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function (id: string) {
      if (id === 'vscode') {
        return vscodeAPI;
      }
      return originalRequire.apply(this, arguments);
    };
    
    // 方法3：添加到 global
    (global as any).vscode = vscodeAPI;
  }
  
  /**
   * 注入 window polyfills（Electron 主进程中不支持的浏览器 API）
   */
  private injectWindowPolyfills(): void {
    // 确保 global.window 存在
    if (typeof (global as any).window === 'undefined') {
      (global as any).window = {};
    }
    
    // 提供 window.prompt 的 stub 实现
    if (typeof (global as any).window.prompt === 'undefined') {
      (global as any).window.prompt = function(message?: string, defaultValue?: string): string | null {
        console.warn('[VSCode Shim] window.prompt() is not fully supported in extension context');
        console.log('[VSCode Shim] Prompt message:', message, 'default:', defaultValue);
        // 返回默认值或空字符串，避免扩展崩溃
        return defaultValue || '';
      };
    }
    
    // 提供 window.alert 的 stub 实现
    if (typeof (global as any).window.alert === 'undefined') {
      (global as any).window.alert = function(message?: string): void {
        console.log('[VSCode Shim] Alert:', message);
      };
    }
    
    // 提供 window.confirm 的 stub 实现
    if (typeof (global as any).window.confirm === 'undefined') {
      (global as any).window.confirm = function(message?: string): boolean {
        console.log('[VSCode Shim] Confirm:', message);
        return true; // 默认返回 true
      };
    }
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    // 停用所有扩展
    const extensionIds = Array.from(this.loadedExtensions.keys());
    for (const id of extensionIds) {
      await this.deactivateExtension(id);
    }

    // 清理 shim
    this.shim.dispose();
  }
}

/**
 * 在子进程中运行 Extension Host（可选）
 */
export class ExtensionHostProcess {
  private child: any; // ChildProcess

  constructor() {
    // 这里可以使用 child_process.fork() 创建子进程
    // 让扩展在独立进程中运行，隔离性更好
  }

  /**
   * 启动 Extension Host 进程
   */
  async start(): Promise<void> {
    // TODO: 实现子进程启动逻辑
  }

  /**
   * 停止 Extension Host 进程
   */
  async stop(): Promise<void> {
    // TODO: 实现子进程停止逻辑
  }
}
