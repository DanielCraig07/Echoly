import * as vscode from 'vscode';
import {
  configureIntranetModel,
  probeLlmConnection,
  getExtensionSettings, CursorAiConfig
} from './configurer';
import {
  StatusBarHandle,
  StatusBarState,
  updateStatusBar,
} from './statusBar';
import { createProxyManager } from './proxy/proxyServer';
import type { ProxyManager } from './proxy/proxyServer';

let proxyManager: ProxyManager | undefined;

export async function probeCommand(statusBar: StatusBarHandle): Promise<void> {
  updateStatusBar(statusBar, { state: StatusBarState.Probing });

  try {
    const result = await probeLlmConnection();

    if (result.ok) {
      const modelLabel = result.models?.length
        ? result.models.join(', ')
        : getExtensionSettings().model;

      updateStatusBar(statusBar, {
        state: StatusBarState.Connected,
        modelName: result.models?.[0] ?? getExtensionSettings().model,
        proxyPort: proxyManager?.port,
      });

      const tooltipParts: string[] = [];
      if (result.models?.length) {
        tooltipParts.push(`可用模型: ${result.models.join(', ')}`);
      }
      tooltipParts.push(`工具调用: ${result.detail.includes('tools=true') ? '支持' : '不支持'}`);

      vscode.window.showInformationMessage(
        `Deepseek 连接成功 — 模型: ${modelLabel}`,
      );
    } else {
      updateStatusBar(statusBar, {
        state: StatusBarState.Disconnected,
        detail: result.detail,
      });

      vscode.window.showErrorMessage(
        `Deepseek 连接失败: ${result.detail}`,
      );
    }
  } catch (err) {
    updateStatusBar(statusBar, {
      state: StatusBarState.Disconnected,
      detail: err instanceof Error ? err.message : String(err),
    });

    vscode.window.showErrorMessage(
      `Deepseek 探测异常: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function configureCommand(statusBar: StatusBarHandle): Promise<void> {
  updateStatusBar(statusBar, { state: StatusBarState.Probing });

  try {
    const result = await configureIntranetModel();

    if (result.success) {
      updateStatusBar(statusBar, {
        state: StatusBarState.Connected,
        modelName: result.configuredModel,
      });

      vscode.window.showInformationMessage(
        `配置成功! ${result.detail}\nCursor 现已指向内网模型。`,
      );
    } else {
      updateStatusBar(statusBar, {
        state: StatusBarState.Disconnected,
        detail: result.detail,
      });

      vscode.window.showErrorMessage(`配置失败: ${result.detail}`);
    }
  } catch (err) {
    updateStatusBar(statusBar, {
      state: StatusBarState.Disconnected,
      detail: err instanceof Error ? err.message : String(err),
    });

    vscode.window.showErrorMessage(
      `配置异常: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function showSettingsCommand(): Promise<void> {
  // 打开 Cursor 设置 JSON
  await vscode.commands.executeCommand(
    'workbench.action.openSettingsJson',
  );

  // 顺便显示当前扩展配置
  const settings = getExtensionSettings();
  vscode.window.showInformationMessage(
    `当前扩展配置:\n地址: ${settings.baseUrl}\n模型: ${settings.model}`,
  );
}

export async function startProxyCommand(statusBar: StatusBarHandle): Promise<void> {
  if (proxyManager?.isRunning()) {
    vscode.window.showWarningMessage(
      `代理服务器已在端口 ${proxyManager.port} 上运行`,
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('deepseek-cursor');
  const port = config.get<number>('proxyPort', 18002);
  const settings = getExtensionSettings();

  proxyManager = createProxyManager(port, settings.baseUrl);

  try {
    await proxyManager.start();
    updateStatusBar(statusBar, {
      state: StatusBarState.Connected,
      modelName: settings.model,
      proxyPort: port,
    });
    vscode.window.showInformationMessage(
      `Deepseek 代理服务器已启动: http://localhost:${port}\n` +
      `转发至: ${settings.baseUrl}\n` +
      `请在 Cursor 设置中配置:\n` +
      `  Override OpenAI Base URL: http://localhost:${port}/v1\n` +
      `  Model: ${settings.model}`,
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `代理服务器启动失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function stopProxyCommand(statusBar: StatusBarHandle): Promise<void> {
  if (!proxyManager?.isRunning()) {
    vscode.window.showInformationMessage('代理服务器未运行');
    return;
  }

  proxyManager.stop();
  proxyManager = undefined;

  const settings = getExtensionSettings();
  updateStatusBar(statusBar, {
    state: StatusBarState.Connected,
    modelName: settings.model,
  });

  vscode.window.showInformationMessage('Deepseek 代理服务器已停止');
}
