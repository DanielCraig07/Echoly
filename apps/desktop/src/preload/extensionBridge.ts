/**
 * Extension Bridge for Preload Script
 * 在 Renderer 进程中暴露扩展 API
 */

import { contextBridge, ipcRenderer } from 'electron';

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
   * 执行扩展命令
   */
  executeCommand(command: string, ...args: any[]): Promise<{ success: boolean; result?: any; error?: string }>;

  /**
   * 获取已加载的扩展列表
   */
  getLoadedExtensions(): Promise<{ success: boolean; extensions?: string[] }>;

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

    async executeCommand(command: string, ...args: any[]) {
      return ipcRenderer.invoke('extension:execute-command', command, ...args);
    },

    async getLoadedExtensions() {
      return ipcRenderer.invoke('extension:get-loaded');
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
