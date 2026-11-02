/**
 * 把远端任务的配置翻成 `runAgent` 认的 AppSettings。
 *
 * 单独拎出来是因为这里藏着一个**安全决策**，而它长得像一段平平无奇的字段赋值：
 * 「无人值守」打开时才给 `allow_all`，关着就是 `ask`。
 * 反过来的默认值（为了「让任务顺利跑完」而默认放行）会变成一条绕过权限模型的旁路 ——
 * 远端没有人在旁边点确认，默认放行等于所有写操作都无需确认。
 *
 * 另一个必须对齐的点：模型配置走 `models` + `activeModelId` 这条路。
 * `runAgent` 优先读 `models` 里选中的那条，其次是 `providers`。塞错地方不会报错，
 * 只会静默用上默认网关 —— 表现为「远端任务跑了，但用的是另一台机器的模型配置」。
 */

import { DEFAULT_SETTINGS, type AppSettings, type RemoteRunnerConfig } from '@deepseek-ide/shared';

/** 远端任务在 settings 里占用的模型位 id。固定值即可，远端只跑一个模型。 */
export const REMOTE_MODEL_ID = 'echoly-remote';

export function buildRemoteSettings(config: RemoteRunnerConfig): AppSettings {
  const apiKey = config.model.apiKey ?? '';
  return {
    ...DEFAULT_SETTINGS,
    // 见文件头：这是这段代码里唯一真正的安全决策
    permissionMode: config.unattended ? 'allow_all' : 'ask',
    maxAgentSteps: config.maxSteps ?? DEFAULT_SETTINGS.maxAgentSteps,
    activeModelId: REMOTE_MODEL_ID,
    models: [
      {
        id: REMOTE_MODEL_ID,
        name: '远端任务模型',
        provider: (config.model.provider ?? 'openai') as AppSettings['models'][number]['provider'],
        baseUrl: config.model.baseUrl,
        model: config.model.model,
        apiKey,
        isDefault: true,
      },
    ],
  };
}
