/**
 * Extension Host
 * 在独立进程中运行 VSCode 扩展
 */

import { VSCodeShim, ExtensionContext, createExtensionContext } from './index';
import { LoadedExtension } from './extensionLoader';
import { setExtensionExports, unregisterExtension } from './extensionRegistry';

export interface ExtensionHostOptions {
  workspaceRoot: string;
  onCommand: (command: string, ...args: any[]) => Promise<any>;
  onMessage: (message: any) => void;
  onWebviewViewRegister?: (
    viewId: string,
    provider: any,
    extensionPath: string,
    options?: any,
    /** 注册它的扩展 id。禁用/卸载时要按它把视图一起摘掉 */
    extensionId?: string,
  ) => void;
  /** 落盘 WorkspaceEdit（自定义编辑器的保存路径）。没给时 applyEdit 返回 false。 */
  onApplyEdit?: (edit: import('./index').WorkspaceEditDescriptor) => Promise<boolean>;
}

export class ExtensionHost {
  /** 注入给扩展的 `vscode` API。写磁盘 shim（ESM 用）时需要知道它有哪些键。 */
  readonly vscodeApi: Record<string, unknown>;
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
      onApplyEdit: options.onApplyEdit,
    });

    // 立即注入 vscode 模块到全局，确保任何扩展 require('vscode') 时都能找到
    const vscodeAPI = this.shim.createAPI();
    this.vscodeApi = vscodeAPI as Record<string, unknown>;
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
    /**
     * `extensions.getExtension(id).exports` 要还给扩展自己模块导出的那份东西。
     *
     * 别的扩展会拿它去调对方暴露的 API（`getAPI(1)` 那套）。给空对象等于
     * 「装了但 API 是空的」，调用方照样炸；给真 exports 才是官方语义。
     */
    setExtensionExports(extensionId, extension.mainModule);
    console.log(`[activateExtension] 扩展信息已保存`);

    // 调用扩展的 activate 函数（vscode 模块已在构造函数中全局注入）
    if (extension.mainModule && typeof extension.mainModule.activate === 'function') {
      try {
        console.log(`[activateExtension] 调用 activate() 函数...`);
        // 扩展注册命令/视图时不会自报家门：在它跑起来之前把「现在是谁」记下，
        // shim 那边注册时就顺手记到归属表里。禁用/卸载要按这份归属去摘。
        this.shim.activeExtensionId = extensionId;
        // 扩展目录也要一起记：注册 webview 视图时要按它算资源地址，
        // 而 shim 自己的 extensionPath 是工作区根目录（见 activeExtensionPath 的注释）
        this.shim.activeExtensionPath = extension.extensionPath;
        await extension.mainModule.activate(context);
        console.log(`[activateExtension] Extension ${extensionId} activated successfully`);
      } catch (err) {
        console.error(`[activateExtension] Failed to activate extension ${extensionId}:`, err);
        throw err;
      } finally {
        this.shim.activeExtensionId = undefined;
        this.shim.activeExtensionPath = undefined;
      }
    } else if (extension.mainModuleError) {
      // 声明了 main 却没加载起来：这是**失败**，不是「这个扩展没有 activate」。
      // 以前这里只打一行日志，用户看到的就是「装上了但没反应」，无从查起。
      throw new Error(
        `扩展主模块加载失败（${extension.manifest.main}）：${extension.mainModuleError}`,
      );
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

    // 清理订阅。
    // 先判 dispose 是不是函数：`context.subscriptions` 是个约定俗成的数组，扩展往里塞
    // **任何东西**都不会被拦（实测 es6kr.claude-sessions 塞进了非 Disposable 的值）。
    // 直接 `sub.dispose()` 会抛 `is not a function` —— 被 catch 住，但每次停用都刷一屏
    // 红字，看起来像 shim 坏了，其实是扩展自己的问题。
    const context = this.extensionContexts.get(extensionId);
    if (context) {
      for (const sub of context.subscriptions) {
        if (typeof sub?.dispose !== 'function') continue;
        try {
          sub.dispose();
        } catch (err) {
          console.error(`Error disposing subscription:`, err);
        }
      }
    }

    // 命令与视图注册也要摘掉：扩展已经停了，留着它的命令只会点出一个空响应
    const droppedViews = this.shim.dropExtensionRegistrations(extensionId);
    if (droppedViews.length > 0) {
      console.log(`[deactivateExtension] ${extensionId} 摘掉视图：${droppedViews.join(', ')}`);
    }

    this.loadedExtensions.delete(extensionId);
    this.extensionContexts.delete(extensionId);
    // 登记簿也要摘：`getExtension` 只认「现在装着的」，停用之后就该是 undefined
    unregisterExtension(extensionId);
  }

  /** 扩展注册的命令（带归属）。命令面板用它列出「扩展命令」。 */
  listExtensionCommands(): { command: string; extensionId?: string }[] {
    return this.shim.listCommands();
  }

  /** 已注册的自定义编辑器（带归属）。宿主据此把文件路由给扩展。 */
  listCustomEditorProviders(): { viewType: string; extensionId?: string; options?: any }[] {
    return this.shim.listCustomEditorProviders();
  }

  /** 某个扩展注册了哪些视图。 */
  listWebviewViewIds(extensionId: string): string[] {
    return this.shim.listWebviewViewIds(extensionId);
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
    // 方法4：留给磁盘上的 shim 模块（见 vscodeShimModule.ts）。
    // ESM 的 `import 'vscode'` 绕不过 require 补丁，只能靠真的模块文件；
    // 那个文件是生成的，它从这里取**当前**这份 API 对象。
    (global as any).__echolyVscodeApi = vscodeAPI;
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
      (global as any).window.prompt = function (
        message?: string,
        defaultValue?: string,
      ): string | null {
        console.warn('[VSCode Shim] window.prompt() is not fully supported in extension context');
        console.log('[VSCode Shim] Prompt message:', message, 'default:', defaultValue);
        // 返回默认值或空字符串，避免扩展崩溃
        return defaultValue || '';
      };
    }

    // 提供 window.alert 的 stub 实现
    if (typeof (global as any).window.alert === 'undefined') {
      (global as any).window.alert = function (message?: string): void {
        console.log('[VSCode Shim] Alert:', message);
      };
    }

    // 提供 window.confirm 的 stub 实现
    if (typeof (global as any).window.confirm === 'undefined') {
      (global as any).window.confirm = function (message?: string): boolean {
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
