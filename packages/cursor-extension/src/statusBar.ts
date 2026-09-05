import * as vscode from 'vscode';

export enum StatusBarState {
  Connected = 'connected',
  Disconnected = 'disconnected',
  Probing = 'probing',
}

export interface StatusBarHandle {
  item: vscode.StatusBarItem;
}

export function createStatusBar(): StatusBarHandle {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.name = 'Deepseek Status';
  return { item };
}

export function updateStatusBar(
  handle: StatusBarHandle,
  opts: {
    state: StatusBarState;
    modelName?: string;
    detail?: string;
    proxyPort?: number;
  },
): void {
  const { item } = handle;

  switch (opts.state) {
    case StatusBarState.Connected: {
      const modelLabel = opts.modelName ?? 'deepseek-v4';
      const proxySuffix = opts.proxyPort ? ` [代理:${opts.proxyPort}]` : '';
      item.text = `$(check) Deepseek: ${modelLabel}${proxySuffix}`;
      item.tooltip = `已连接到内网模型服务器\n模型: ${modelLabel}${opts.proxyPort ? `\n本地代理端口: ${opts.proxyPort}` : ''}`;
      item.backgroundColor = undefined;
      break;
    }
    case StatusBarState.Disconnected: {
      item.text = `$(circle-slash) Deepseek: 离线`;
      item.tooltip = `无法连接内网模型服务器\n${opts.detail ?? '未知错误'}`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
    }
    case StatusBarState.Probing: {
      item.text = `$(sync~spin) Deepseek: 探测中...`;
      item.tooltip = '正在测试与内网模型服务器的连接';
      item.backgroundColor = undefined;
      break;
    }
  }

  item.show();
}

export async function showStatusMenu(): Promise<void> {
  const items: vscode.QuickPickItem[] = [
    {
      label: '$(plug) 测试连接',
      description: '探测内网模型服务器',
      detail: '调用 /v1/models 和简单对话测试连接',
    },
    {
      label: '$(gear) 配置内网模型',
      description: '自动写入 Cursor AI 设置',
      detail: '配置 cursor.general.aiBase.* 指向内网地址',
    },
    {
      label: '$(eye) 查看当前配置',
      description: '打开 Cursor 设置查看当前 AI 配置',
    },
    {
      label: '$(server) 启动本地代理',
      description: '启动 OpenAI 兼容代理服务器（端口 18002）',
    },
    {
      label: '$(debug-stop) 停止本地代理',
      description: '停止正在运行的代理服务器',
    },
  ];

  const result = await vscode.window.showQuickPick(items, {
    placeHolder: '选择 Deepseek 操作',
    title: 'Deepseek Intranet Connector',
  });

  if (!result) return;

  const labelMap: Record<string, string> = {
    '$(plug) 测试连接': 'deepseek-cursor.probe',
    '$(gear) 配置内网模型': 'deepseek-cursor.configure',
    '$(eye) 查看当前配置': 'deepseek-cursor.showSettings',
    '$(server) 启动本地代理': 'deepseek-cursor.startProxy',
    '$(debug-stop) 停止本地代理': 'deepseek-cursor.stopProxy',
  };

  const commandId = labelMap[result.label];
  if (commandId) {
    vscode.commands.executeCommand(commandId);
  }
}
