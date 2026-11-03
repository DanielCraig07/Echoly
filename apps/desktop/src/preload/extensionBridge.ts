/**
 * Extension Bridge for Preload Script
 * 在 Renderer 进程中暴露扩展 API
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { MarketplaceDetailEntry, MarketplaceEntry } from '@deepseek-ide/shared';

/**
 * 一条「已安装扩展」。
 *
 * 与主进程 `InstalledExtensionInfo` 对应：这里只关心界面要用到的字段。
 * `views` 非空时详情页才给「打开视图」入口 —— 扩展没贡献视图时点了也没内容。
 */
export interface InstalledExtension {
  id: string;
  displayName: string;
  version?: string;
  enabled: boolean;
  active: boolean;
  /** 它注册的命令（带标题）。详情页据此列出「贡献的命令」并直接运行。 */
  commands: { command: string; title: string }[];
  /** 它注册的视图 id 列表（每个都能在编辑器区打开）。 */
  views: string[];
}

export interface ExtensionAPI {
  /**
   * 安装 Claude Code 扩展
   */
  installClaudeCode(): Promise<{ success: boolean; error?: string }>;

  /**
   * 从路径加载扩展
   */
  loadFromPath(extensionPath: string): Promise<{ success: boolean; error?: string }>;

  /**
   * 在 Open VSX 注册表上搜索扩展
   */
  searchMarketplace(
    query: string,
    size?: number,
  ): Promise<{
    ok: boolean;
    error?: string;
    extensions: MarketplaceEntry[];
  }>;

  /**
   * 拉取推荐列表（热门扩展，按下载量倒序）
   */
  getRecommendedExtensions(size?: number): Promise<{
    ok: boolean;
    error?: string;
    extensions: MarketplaceEntry[];
  }>;

  /**
   * 取扩展图标的 data URL。抓不到返回 null（渲染层回退到首字母头像）。
   */
  getIconDataUrl(iconUrl: string): Promise<string | null>;

  /**
   * 拉扩展详情（含 README 正文）。失败时 `ok:false`，由渲染层决定怎么兜底。
   */
  getExtensionDetail(id: string): Promise<{
    ok: boolean;
    error?: string;
    detail?: MarketplaceDetailEntry;
    readme?: string;
  }>;

  /**
   * 从市场安装并激活一个扩展
   */
  installFromMarketplace(extension: {
    id: string;
    downloadUrl: string;
    version?: string;
    /** 展示名，仅用于进度显示 */
    displayName?: string;
  }): Promise<{ success: boolean; error?: string; warning?: string }>;

  /**
   * 执行扩展命令
   */
  executeCommand(
    command: string,
    ...args: any[]
  ): Promise<{ success: boolean; result?: any; error?: string }>;

  /**
   * 获取已加载的扩展列表
   */
  getLoadedExtensions(): Promise<{ success: boolean; extensions?: string[] }>;

  /**
   * 已安装扩展的登记表：版本、启用状态、贡献的命令与视图。
   *
   * 管理界面（禁用/启用/卸载/打开视图）吃这一份 —— `getLoadedExtensions` 只给 id，
   * 不够判断「能禁用吗、有视图可开吗」。`active` 与 `enabled` 是两回事：
   * 启用了的扩展也可能因为激活失败而没跑起来。
   */
  listInstalled(): Promise<{ success: boolean; extensions?: InstalledExtension[]; error?: string }>;

  /** 所有扩展贡献的命令（命令面板用）。 */
  listCommands(): Promise<{
    success: boolean;
    commands?: { command: string; extensionId?: string }[];
  }>;

  /** 启用 / 禁用扩展。启用会就地激活，不必重启。 */
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;

  /** 卸载扩展：停用并删除本地文件。 */
  uninstall(id: string): Promise<{ ok: boolean; error?: string }>;

  /**
   * 监听扩展命令
   */
  onCommand(callback: (data: { command: string; args: any[] }) => void): () => void;

  /**
   * 监听扩展消息
   */
  onMessage(callback: (message: any) => void): () => void;
}

/**
 * 创建扩展 API
 */
export function createExtensionAPI(): ExtensionAPI {
  return {
    async installClaudeCode() {
      return ipcRenderer.invoke('extension:install-claude-code');
    },

    async loadFromPath(extensionPath: string) {
      return ipcRenderer.invoke('extension:load-from-path', extensionPath);
    },

    async searchMarketplace(query: string, size?: number) {
      return ipcRenderer.invoke('extension:marketplace-search', query, size);
    },

    async getRecommendedExtensions(size?: number) {
      return ipcRenderer.invoke('extension:marketplace-recommended', size);
    },

    async getIconDataUrl(iconUrl: string) {
      return ipcRenderer.invoke('extension:icon-data-url', iconUrl);
    },

    async getExtensionDetail(id: string) {
      return ipcRenderer.invoke('extension:detail', id);
    },

    async installFromMarketplace(extension: { id: string; downloadUrl: string; version?: string }) {
      return ipcRenderer.invoke('extension:install-from-marketplace', extension);
    },

    async executeCommand(command: string, ...args: any[]) {
      return ipcRenderer.invoke('extension:execute-command', command, ...args);
    },

    async getLoadedExtensions() {
      return ipcRenderer.invoke('extension:get-loaded');
    },

    async listInstalled() {
      return ipcRenderer.invoke('extension:list-installed');
    },

    async listCommands() {
      return ipcRenderer.invoke('extension:list-commands');
    },

    async setEnabled(id: string, enabled: boolean) {
      return ipcRenderer.invoke('extension:set-enabled', id, enabled);
    },

    async uninstall(id: string) {
      return ipcRenderer.invoke('extension:uninstall', id);
    },

    onCommand(callback: (data: { command: string; args: any[] }) => void) {
      const listener = (_event: any, data: any) => callback(data);
      ipcRenderer.on('extension:command', listener);
      return () => ipcRenderer.removeListener('extension:command', listener);
    },

    onMessage(callback: (message: any) => void) {
      const listener = (_event: any, message: any) => callback(message);
      ipcRenderer.on('extension:message', listener);
      return () => ipcRenderer.removeListener('extension:message', listener);
    },
  };
}

/**
 * 暴露扩展 API 到渲染进程
 */
export function exposeExtensionAPI(): void {
  contextBridge.exposeInMainWorld('extensions', createExtensionAPI());
}
