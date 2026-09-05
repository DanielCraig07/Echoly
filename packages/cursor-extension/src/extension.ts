import * as vscode from 'vscode';
import { createStatusBar, updateStatusBar, showStatusMenu, StatusBarState } from './statusBar';
import { configureIntranetModel } from './configurer';
import {
  probeCommand,
  configureCommand,
  showSettingsCommand,
  startProxyCommand,
  stopProxyCommand,
} from './commands';

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar.item);

  // 初始状态：探测中
  updateStatusBar(statusBar, { state: StatusBarState.Probing });

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-cursor.probe', () => probeCommand(statusBar)),
    vscode.commands.registerCommand('deepseek-cursor.configure', async () => {
      await configureCommand(statusBar);
    }),
    vscode.commands.registerCommand('deepseek-cursor.showSettings', () => showSettingsCommand()),
    vscode.commands.registerCommand('deepseek-cursor.startProxy', async () => {
      await startProxyCommand(statusBar);
    }),
    vscode.commands.registerCommand('deepseek-cursor.stopProxy', async () => {
      await stopProxyCommand(statusBar);
    }),
  );

  // 状态栏点击弹出菜单
  statusBar.item.command = 'deepseek-cursor._showMenu';
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-cursor._showMenu', () => showStatusMenu()),
  );

  // 启动时自动探测
  probeCommand(statusBar);

  // 监听配置变更
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('deepseek-cursor')) {
        probeCommand(statusBar);
      }
    }),
  );
}

export function deactivate(): void {
  // 清理由 commands.ts 管理的代理服务器
  void stopProxyCommand(undefined as any);
}
