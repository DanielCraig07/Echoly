import * as vscode from 'vscode';
import { LlmClient, probeLlm } from '@deepseek-ide/llm';
import type { AppSettings } from '@deepseek-ide/shared';

export interface CursorAiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function getExtensionSettings(): CursorAiConfig {
  const config = vscode.workspace.getConfiguration('deepseek-cursor');
  return {
    baseUrl: config.get<string>('baseUrl', 'http://192.168.10.241:8002'),
    model: config.get<string>('model', 'deepseek-v4'),
    apiKey: config.get<string>('apiKey', ''),
  };
}

/**
 * 探测内网 LLM 服务器，返回可用模型列表。
 */
export async function probeLlmConnection(
  baseUrl?: string,
  apiKey?: string,
): Promise<{
  ok: boolean;
  detail: string;
  models?: string[];
}> {
  const settings = getExtensionSettings();
  const url = baseUrl ?? settings.baseUrl;
  const key = apiKey ?? settings.apiKey;

  return probeLlm({ baseUrl: url, apiKey: key });
}

/**
 * 自动配置 Cursor 使用内网模型。
 *
 * 流程：
 * 1. 探测内网 LLM 服务器获取可用模型列表
 * 2. 让用户选择模型（如果有多个）
 * 3. 写入 Cursor AI 配置项
 */
export async function configureIntranetModel(): Promise<{
  success: boolean;
  detail: string;
  configuredModel?: string;
}> {
  const settings = getExtensionSettings();

  // 1. 探测
  const result = await probeLlmConnection();
  if (!result.ok) {
    return {
      success: false,
      detail: `探测失败: ${result.detail}`,
    };
  }

  // 2. 选择模型
  let selectedModel = settings.model;
  if (result.models && result.models.length > 0) {
    // 默认选中配置中的模型，如果不在列表中则用第一个
    const defaultModel = result.models.includes(settings.model)
      ? settings.model
      : result.models[0];

    const pickResult = await vscode.window.showQuickPick(result.models, {
      placeHolder: '选择模型',
      title: `探测到 ${result.models.length} 个模型`,
      canPickMany: false,
    });

    if (!pickResult) {
      // 用户取消，使用默认
      selectedModel = defaultModel;
    } else {
      selectedModel = pickResult;
    }
  }

  // 3. 写入 Cursor 配置
  const cursorConfig = vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Global;

  try {
    // 写入 Cursor 的 AI base URL（Cursor 使用这些设置项来路由 AI 请求）
    await cursorConfig.update(
      'cursor.general.aiBase.url',
      settings.baseUrl,
      target,
    );
    await cursorConfig.update(
      'cursor.general.aiBase.model',
      selectedModel,
      target,
    );
    await cursorConfig.update(
      'cursor.general.aiBase.apiKey',
      settings.apiKey || undefined,
      target,
    );

    return {
      success: true,
      detail: `已配置: ${settings.baseUrl} / ${selectedModel}`,
      configuredModel: selectedModel,
    };
  } catch (err) {
    return {
      success: false,
      detail: `写入配置失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
