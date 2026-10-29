export const APP_VERSION = '0.0.57';
export const DEFAULT_LLM_BASE_URL = 'http://192.168.10.241:8002';
/**
 * 内网 vLLM 实际 serve 出来的模型名。
 * 曾经写的是 `deepseek-v4-flash`，但那个 id 在 241 上根本不存在 ——
 * 8002 报 `The model ... does not exist`，1333 网关报 `No available channel`，
 * 只有 `deepseek-v4.1-flash` 两边都认。
 */
export const DEFAULT_LLM_MODEL = 'deepseek-v4.1-flash';

/** AI Provider types */
export type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'custom';
export type ModelProviderType = AiProvider;

/**
 * OpenAI 兼容端点上的思考深度档位。
 *
 * 内网 DeepSeek-V4.1（vLLM 定制分支）支持的档位**不是** OpenAI 全集：
 * 实测 `minimal` / `medium` 会被服务端直接 400 拒绝，原话是
 * 「must be low, high, xhigh, max, or an integer within [1, 100] in chat_template_kwargs」。
 * 因此这里只收录实测可用的档位 —— 与其靠 400 兜底降级，不如根本不给选。
 */
export type ReasoningEffort = 'none' | 'low' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: '关闭思考',
  low: '低',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Claude (Anthropic)',
  custom: '自定义 (OpenAI 兼容)',
};

/** Single Model Configuration Profile */
export interface ModelProfile {
  id: string;
  name: string;
  provider: ModelProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** For Anthropic: support extended thinking */
  enableThinking?: boolean;
  /** For Anthropic: thinking tokens budget */
  thinkingTokens?: number;
  /**
   * For OpenAI-compatible reasoning models: thinking depth.
   * Sent as top-level `reasoning_effort`. Unset = use the server default.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Fine-grained depth (integer 1–100), sent as
   * `chat_template_kwargs.reasoning_effort`. Takes precedence over `reasoningEffort`
   * when set — it is the same knob at finer granularity, not a second one.
   */
  reasoningEffortFine?: number;
  /**
   * Hard cap on reasoning tokens (`thinking_token_budget`). Unlike the two fields
   * above this does not scale effort, it truncates: setting 256 yields ~256 tokens.
   * 0 / unset = do not send. Useful as a runaway-thinking safety valve.
   */
  thinkingTokenBudget?: number;
  isDefault?: boolean;
  lastProbeOk?: boolean;
}

export const DEFAULT_MODELS: ModelProfile[] = [
  {
    id: 'deepseek-local',
    name: 'DeepSeek V4.1 (内网网关)',
    provider: 'deepseek',
    baseUrl: 'http://192.168.10.241:1333',
    model: 'deepseek-v4.1-flash',
    apiKey: '',
    reasoningEffort: 'low',
    isDefault: true,
  },
  {
    id: 'deepseek-official',
    name: 'DeepSeek (官方 API)',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: '',
  },
  {
    id: 'openai-gpt4o',
    name: 'OpenAI (GPT-4o)',
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o',
    apiKey: '',
  },
  {
    id: 'anthropic-claude37',
    name: 'Claude 3.7 Sonnet',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-7-sonnet-20250219',
    apiKey: '',
    enableThinking: true,
    thinkingTokens: 8000,
  },
];

/** Provider-specific configuration */
export interface ProviderConfig {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** For Anthropic: support extended thinking */
  enableThinking?: boolean;
  /** For Anthropic: thinking tokens budget */
  thinkingTokens?: number;
  /** For OpenAI-compatible reasoning models: thinking depth (`reasoning_effort`). */
  reasoningEffort?: ReasoningEffort;
  /** Fine-grained thinking depth (1–100) via `chat_template_kwargs.reasoning_effort`. */
  reasoningEffortFine?: number;
  /** Hard cap on reasoning tokens (`thinking_token_budget`). 0 = 不发送。 */
  thinkingTokenBudget?: number;
  /**
   * 服务端侧的原生重复检测（vLLM `repetition_detection`）。
   * 开启后由推理引擎在生成过程中自行掐断复读，比客户端熔断更早、更省算力。
   */
  serverRepetitionDetection?: boolean;
}

export const DEFAULT_PROVIDERS: Record<AiProvider, Omit<ProviderConfig, 'apiKey'>> = {
  deepseek: {
    provider: 'deepseek',
    baseUrl: 'http://192.168.10.241:8002',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'low',
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o',
  },
  anthropic: {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    enableThinking: true,
    thinkingTokens: 10000,
  },
  custom: {
    provider: 'custom',
    baseUrl: DEFAULT_LLM_BASE_URL,
    model: DEFAULT_LLM_MODEL,
  },
};

/** Tool permission policy for Agent mode. */
export type PermissionMode = 'allow_all_extreme' | 'allow_all' | 'ask' | 'deny_all';

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  allow_all_extreme: '允许所有操作·极',
  allow_all: '允许所有操作',
  ask: '询问后允许',
  deny_all: '不允许任何操作',
};

export interface LayoutSettings {
  explorerWidth: number;
  chatWidth: number;
  bottomHeight: number;
  leftPanelExpanded?: boolean;
  bottomPanelExpanded?: boolean;
  chatPanelExpanded?: boolean;
  bottomActiveTab?: 'terminal' | 'diff';
}

export type UiTheme = 'dark' | 'light';

export interface AppSettings {
  /** Configured models list */
  models: ModelProfile[];
  /** Currently active model ID */
  activeModelId: string;

  /** Current active provider (legacy) */
  currentProvider: AiProvider;
  /** Provider-specific configurations (legacy) */
  providers: Record<AiProvider, ProviderConfig>;

  /** @deprecated Legacy fields - migrated to providers */
  baseUrl?: string;
  model?: string;
  apiKey?: string;

  temperature: number;
  maxAgentSteps: number;
  /**
   * 单次生成的输出 token 上限（含推理模型的思考 token）。
   * 作为复读退化的兜底上界：周期检测是主要防线，这里是「万一漏网」的硬闸。
   * 写得过大等于没有上界，过小会截断合法的长文件写入，默认 32768。
   * 设为 0 表示不发送该字段（供不认识的网关使用）。
   */
  maxOutputTokens?: number;
  /**
   * 频率惩罚（0~2）：按 token 出现频次施加惩罚，用于抑制逐字复读。
   * 默认 0.3；设为 0 表示不发送该字段。
   */
  frequencyPenalty?: number;
  /**
   * 存在惩罚（0~2）：按 token 是否已出现施加惩罚，用于抑制复述已有内容。
   * 默认 0.3；设为 0 表示不发送该字段。
   */
  presencePenalty?: number;
  /**
   * 是否启用周期性重复熔断。默认 true。
   * 关闭后仅保留 maxOutputTokens 这一层上界。
   */
  repetitionGuard?: boolean;
  /**
   * 是否请求服务端原生重复检测（vLLM `repetition_detection`）。
   * 默认 true。由推理引擎在生成中掐断复读，比客户端熔断更早、更省算力；
   * 不支持的网关会因未知字段被自动降级摘除，不影响请求本身。
   */
  serverRepetitionDetection?: boolean;
  /** @deprecated Prefer permissionMode; kept for migration. */
  autoApproveReadonlyTerminal: boolean;
  /** @deprecated Prefer permissionMode; kept for migration. */
  requireConfirmForWrites: boolean;
  permissionMode: PermissionMode;
  contextWindowTokens: number;
  layout: LayoutSettings;
  /** UI color theme. Default dark; light uses Echoly white/purple. */
  theme: UiTheme;
  /** Debounced write on editor change when enabled. */
  autoSave: boolean;
  /** 是否在编辑器光标所在行常驻显示 Git Blame 提交信息。默认 true。 */
  gitBlameInline?: boolean;
  /** 自动更新源配置。未配置时禁用自动更新。 */
  updateFeed?: UpdateFeedConfig | null;
  /** 鼠标悬浮提示延迟时间（毫秒），最低 500ms。默认 500ms。 */
  hoverDelay?: number;
  /** 是否在选中代码时显示浮动 AI 提问/编辑操作栏。默认 true。 */
  selectionAiFloat?: boolean;
  /** 是否开启编辑区右侧代码缩略图 (Minimap)。默认 true。 */
  minimap?: boolean;
  /** 终端回滚缓存最大行数上限 (Scrollback lines)，默认 10000 行。 */
  terminalScrollback?: number;
  /** 键盘快捷键预设模式 ('vscode' | 'intellij')，默认 'vscode'。 */
  keymapPreset?: 'vscode' | 'intellij';
  /** 是否开启保存文件时自动格式化 (Format on Save)。默认 true。 */
  formatOnSave?: boolean;
  /** 大文件安全保护阈值大小（字节）。默认 2MB (2 * 1024 * 1024)。 */
  largeFileThresholdBytes?: number;
  /**
   * 用户配置的 MCP 服务器。默认空数组 —— 不预置任何服务器。
   *
   * 预置示例服务器看似友好，实则危险：用户升级后会在毫不知情的情况下
   * 启动一个能访问外部系统的子进程。这类能力必须由用户显式添加。
   */
  mcpServers?: McpServerConfig[];
}

export interface UpdateFeedConfig {
  provider: 'github' | 'generic';
  /** github 仓库 owner（默认 DanielCraig07） */
  owner?: string;
  /** github 仓库名（默认 Echoly） */
  repo?: string;
  /** generic 静态服务器地址（内网推荐） */
  genericUrl?: string;
  /** 私有仓库下载令牌（GitHub PAT）。用于从私有 Release 拉取更新，仅存本机。 */
  token?: string;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  explorerWidth: 200,
  chatWidth: 300,
  bottomHeight: 220,
  leftPanelExpanded: true,
  bottomPanelExpanded: false,
  chatPanelExpanded: true,
  bottomActiveTab: 'terminal',
};

export const DEFAULT_SETTINGS: AppSettings = {
  models: [...DEFAULT_MODELS],
  activeModelId: 'deepseek-local',
  currentProvider: 'deepseek',
  providers: {
    deepseek: { ...DEFAULT_PROVIDERS.deepseek, apiKey: '' },
    openai: { ...DEFAULT_PROVIDERS.openai, apiKey: '' },
    anthropic: { ...DEFAULT_PROVIDERS.anthropic, apiKey: '' },
    custom: { ...DEFAULT_PROVIDERS.custom, apiKey: '' },
  },
  // Legacy fields
  baseUrl: DEFAULT_LLM_BASE_URL,
  model: DEFAULT_LLM_MODEL,
  apiKey: '',

  temperature: 0.2,
  maxAgentSteps: 50,
  maxOutputTokens: 32768,
  frequencyPenalty: 0.3,
  presencePenalty: 0.3,
  repetitionGuard: true,
  serverRepetitionDetection: true,
  autoApproveReadonlyTerminal: true,
  requireConfirmForWrites: false,
  permissionMode: 'ask',
  contextWindowTokens: 128000,
  layout: { ...DEFAULT_LAYOUT },
  theme: 'dark',
  autoSave: false,
  gitBlameInline: true,
  hoverDelay: 500,
  selectionAiFloat: true,
  minimap: true,
  terminalScrollback: 10000,
  updateFeed: null,
  keymapPreset: 'vscode',
  formatOnSave: false,
  largeFileThresholdBytes: 2 * 1024 * 1024,
  mcpServers: [],
};

/**
 * 一个 MCP 服务器的配置。
 *
 * 定义在 shared 而不是 agent 包，是因为三个地方都要用它，且它们的依赖方向不允许：
 * 设置界面（渲染层）要读写它，主进程要持久化它，agent/tools 包要据此判断工具只读性。
 * 若放在 agent 包里，渲染层就得反向依赖 agent —— 而渲染层是不知道 Agent 循环的。
 *
 * 与 `packages/agent/src/mcp/manager.ts` 的 `McpServerConfig` 保持一致（那边是执行侧视图）。
 */
export interface McpServerConfig {
  /** 稳定标识，用于工具名前缀与去重。 */
  id: string;
  name: string;
  enabled: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  /** 额外环境变量。密钥放这里，不要放 args —— args 会出现在进程列表里。 */
  env?: Record<string, string>;
  /** Windows 下启动 npx/uvx 这类 `.cmd` 包装器需要开。默认 false。 */
  shell?: boolean;
  requestTimeoutMs?: number;
  /**
   * 启动后等待 initialize 响应的上限（毫秒）。
   *
   * 与 `requestTimeoutMs` 分开：冷启动可能要等 `npx` 下载整个包，比任何单次工具调用都慢得多。
   * 默认取 `max(requestTimeoutMs, 60000)`；只有在明确知道服务器启动很快时才该调小。
   */
  connectTimeoutMs?: number;
  /**
   * 该服务器工具的影响面，默认 'write'。
   *
   * 只读的服务器其工具才会出现在 Ask / Plan 模式下。默认值必须是保守的：
   * MCP 协议里没有任何字段能告诉我们一个工具会不会改数据，
   * 声明错了的代价是 Agent 在「只读模式」里拿到了写权限。
   */
  access?: 'readonly' | 'write';
}

/** 单个 MCP 服务器的运行时状态，供设置页展示。 */
export interface McpServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  state: 'idle' | 'connecting' | 'ready' | 'error';
  toolCount: number;
  /** 因超出单服务器工具数上限而未暴露的数量。 */
  truncated: number;
  error?: string;
  /** 最近的服务端 stderr，供用户自查（连不上时最有用）。 */
  stderr?: string;
}

/**
 * 一条自定义 slash 命令。
 *
 * `source` 决定它在设置页里的分组与优先级：工作区内的命令会覆盖同名的用户级命令 ——
 * 项目自带的命令必须能盖过个人全局偏好，否则同一个 `/review` 在不同仓库里
 * 行为不一致，而用户无从知道当前生效的是哪一份。
 */
export interface SlashCommandInfo {
  name: string;
  description: string;
  body: string;
  source: 'workspace' | 'user';
  path: string;
  /** 工作区相对路径或绝对路径：写入 prompt 时告诉模型命令来自哪里。 */
  origin: string;
}

/**
 * 把一条命令渲染成实际发给模型的内容。
 *
 * 放在 shared 而非 skills 包里，是因为**渲染方在渲染进程**：ChatPanel 要在用户
 * 选中命令的瞬间把正文填进输入框。skills 包依赖 node:fs / node:path，
 * 引入渲染进程会把 Node 内置模块打进 renderer bundle。
 *
 * `$ARGUMENTS` 占位符是刻意的选择：命令模板里几乎总有一处需要用户补具体对象
 * （改哪个文件、查哪个表），而把它放开头还是结尾取决于模板本身的语序。
 * 没有占位符时把参数追加到末尾，比丢弃参数好 —— 用户敲了字却什么都没发生，
 * 是最让人困惑的失败方式。
 */
export function renderCommand(command: Pick<SlashCommandInfo, 'body'>, args: string): string {
  const body = command.body.trim();
  const trimmedArgs = args.trim();
  if (!body) return trimmedArgs;
  if (/\$ARGUMENTS\b/.test(body)) {
    return body.replace(/\$ARGUMENTS\b/g, trimmedArgs);
  }
  return trimmedArgs ? `${body}\n\n${trimmedArgs}` : body;
}

/** Migrate legacy settings to new provider and model structure */
export function migrateToProviderSettings(raw: Partial<AppSettings>): AppSettings {
  const base = { ...DEFAULT_SETTINGS };

  // If old format detected, migrate to new structure
  if (raw.baseUrl || raw.model || raw.apiKey) {
    const legacyProvider: ProviderConfig = {
      provider: 'custom',
      baseUrl: raw.baseUrl || DEFAULT_LLM_BASE_URL,
      model: raw.model || DEFAULT_LLM_MODEL,
      apiKey: raw.apiKey || '',
    };
    base.providers.custom = legacyProvider;
    base.currentProvider = 'custom';
  }

  // Merge with existing provider configs
  if (raw.providers) {
    base.providers = { ...base.providers, ...raw.providers };
  }

  if (raw.currentProvider) {
    base.currentProvider = raw.currentProvider;
  }

  // Migrate or preserve models list
  if (Array.isArray(raw.models) && raw.models.length > 0) {
    base.models = raw.models;
  } else {
    // Populate models from providers if available
    const migratedModels: ModelProfile[] = [];
    if (base.providers.deepseek) {
      migratedModels.push({
        id: 'deepseek-migrated',
        name: 'DeepSeek',
        provider: 'deepseek',
        baseUrl: base.providers.deepseek.baseUrl || 'http://192.168.10.241:8002',
        apiKey: base.providers.deepseek.apiKey || '',
        model: base.providers.deepseek.model || DEFAULT_LLM_MODEL,
        isDefault: base.currentProvider === 'deepseek',
      });
    }
    if (base.providers.openai) {
      migratedModels.push({
        id: 'openai-migrated',
        name: 'OpenAI',
        provider: 'openai',
        baseUrl: base.providers.openai.baseUrl || 'https://api.openai.com',
        apiKey: base.providers.openai.apiKey || '',
        model: base.providers.openai.model || 'gpt-4o',
        isDefault: base.currentProvider === 'openai',
      });
    }
    if (base.providers.anthropic) {
      migratedModels.push({
        id: 'anthropic-migrated',
        name: 'Claude',
        provider: 'anthropic',
        baseUrl: base.providers.anthropic.baseUrl || 'https://api.anthropic.com',
        apiKey: base.providers.anthropic.apiKey || '',
        model: base.providers.anthropic.model || 'claude-sonnet-4-20250514',
        enableThinking: base.providers.anthropic.enableThinking,
        thinkingTokens: base.providers.anthropic.thinkingTokens,
        isDefault: base.currentProvider === 'anthropic',
      });
    }
    if (base.providers.custom?.baseUrl) {
      migratedModels.push({
        id: 'custom-migrated',
        name: '自定义模型',
        provider: 'custom',
        baseUrl: base.providers.custom.baseUrl,
        apiKey: base.providers.custom.apiKey || '',
        model: base.providers.custom.model || 'default',
        isDefault: base.currentProvider === 'custom',
      });
    }
    base.models = migratedModels.length > 0 ? migratedModels : [...DEFAULT_MODELS];
  }

  if (raw.activeModelId && base.models.some((m) => m.id === raw.activeModelId)) {
    base.activeModelId = raw.activeModelId;
  } else {
    const defaultModel = base.models.find((m) => m.isDefault);
    base.activeModelId = defaultModel ? defaultModel.id : base.models[0]?.id || 'deepseek-local';
  }

  return base;
}

export function migratePermissionMode(
  raw: Partial<AppSettings> & { permissionMode?: PermissionMode },
): PermissionMode {
  if (
    raw.permissionMode === 'allow_all_extreme' ||
    raw.permissionMode === 'allow_all' ||
    raw.permissionMode === 'ask' ||
    raw.permissionMode === 'deny_all'
  ) {
    return raw.permissionMode;
  }
  if (raw.requireConfirmForWrites === true) return 'ask';
  if (raw.requireConfirmForWrites === false) return 'allow_all';
  return DEFAULT_SETTINGS.permissionMode;
}

export function syncPermissionBooleans(mode: PermissionMode): {
  autoApproveReadonlyTerminal: boolean;
  requireConfirmForWrites: boolean;
} {
  switch (mode) {
    case 'allow_all_extreme':
    case 'allow_all':
      return { autoApproveReadonlyTerminal: true, requireConfirmForWrites: false };
    case 'deny_all':
      return { autoApproveReadonlyTerminal: false, requireConfirmForWrites: true };
    case 'ask':
    default:
      return { autoApproveReadonlyTerminal: true, requireConfirmForWrites: true };
  }
}

export type AgentMode = 'ask' | 'plan' | 'agent';

export type PlanTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface PlanTodo {
  id: string;
  content: string;
  status: PlanTodoStatus;
}

export interface PlanProposal {
  title: string;
  summary: string;
  todos: PlanTodo[];
}

export interface PlanContext {
  title: string;
  summary: string;
  todos: PlanTodo[];
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

/** Claude Extended Thinking block */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /**
   * 思考块的签名，由 Anthropic 在流式响应里以 `signature_delta` 下发。
   *
   * 有这个字段是**回传思考链的必要条件**：接口要求带 thinking 的 assistant 消息
   * 必须连同签名一起回传，缺签名会直接 400。所以「把 thinking 塞进历史消息」
   * 在没有它的时候只能靠丢弃思考块来绕开 —— 代价是模型看不到自己上一轮的推理。
   */
  signature?: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Claude Extended Thinking content */
  thinking?: ThinkingBlock[];
  /** DeepSeek / QwQ / OpenAI reasoning content */
  reasoning_content?: string;
  /** Optional image attachments for multimodal models */
  images?: Array<{ dataUrl: string; mediaType: string }>;
  /** Optional document attachments (e.g. PDF) for multimodal models */
  documents?: Array<{ dataUrl: string; mediaType: string; name?: string }>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  /** 单次生成的最大 token 数，作为复读退化的兜底上界。 */
  max_tokens?: number;
  /** 频率惩罚，抑制逐字复读。 */
  frequency_penalty?: number;
  /** 存在惩罚，抑制复述已有内容。 */
  presence_penalty?: number;
  /**
   * 思考深度档位。注意内网 DeepSeek-V4.1 只认 none/low/high/xhigh/max，
   * 传 minimal 或 medium 会被服务端 400 拒绝，且顶层不接受整数。
   */
  reasoning_effort?: ReasoningEffort;
  /** 传给 chat template 的额外参数（整数档位、关闭思考等走这里）。 */
  chat_template_kwargs?: {
    /** 整数档位 1–100，与推理引擎的细粒度深度对应。 */
    reasoning_effort?: number;
    /** 是否启用思考（DeepSeek-V4.1 的 chat template 开关）。 */
    thinking?: boolean;
    [key: string]: unknown;
  };
  /** 思考 token 硬上限。与 reasoning_effort 不同，它是截断而非缩放。 */
  thinking_token_budget?: number;
  /**
   * 服务端原生重复检测（vLLM）。命中时 finish_reason 会变成 `repetition`，
   * 生成在推理引擎内部就被终止，比客户端熔断更早。
   */
  repetition_detection?: {
    /** 同一 pattern 至少重复多少次才判定为复读。 */
    min_count?: number;
    min_pattern_size?: number;
    max_pattern_size?: number;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * 估算纯文本消耗的 Token 数。
 * 粗略圈定 CJK 与常见全角标点按一字一 token，其余按 4 字符一 token。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x3040 && c <= 0x30ff) || // 日文假名
      (c >= 0x3400 && c <= 0x4dbf) || // 扩展 A
      (c >= 0x4e00 && c <= 0x9fff) || // 基本区
      (c >= 0xf900 && c <= 0xfaff) || // 兼容表意
      (c >= 0xff00 && c <= 0xff60) || // 全角
      (c >= 0x3000 && c <= 0x303f) // CJK 标点
    ) {
      cjk++;
    }
  }
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export type StreamChunkDelta = {
  role?: ChatRole;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
};

export interface StreamChunk {
  id: string;
  choices: Array<{
    index: number;
    delta: StreamChunkDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export type AgentRunStatus =
  | 'idle'
  | 'thinking'
  | 'tool_running'
  | 'awaiting_confirm'
  | 'awaiting_continue'
  | 'done'
  | 'error'
  | 'cancelled';

export type AgentEvent =
  | { type: 'status'; status: AgentRunStatus }
  | { type: 'token'; text: string }
  | { type: 'thinking_token'; text: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'tool_start'; id: string; name: string; args: unknown }
  | { type: 'tool_output'; id: string; chunk: string }
  | { type: 'tool_result'; id: string; name: string; result: string; isError?: boolean }
  | { type: 'pending_diff'; diff: PendingDiff }
  | { type: 'confirm_request'; request: ConfirmRequest }
  | { type: 'confirm_resolved'; requestId: string; reason?: 'auto_approved' | 'user' | 'cancelled' }
  | { type: 'plan_proposal'; plan: PlanProposal }
  | { type: 'step_progress'; step: number; maxSteps: number }
  | { type: 'max_steps_reached'; completedSteps: number; chunkSize: number }
  /** 运行中被追加的用户消息已进入模型上下文（回执，用于把气泡从「排队中」转为「已送达」）。 */
  | { type: 'queued_message_consumed'; id: string }
  /** 本轮在这些消息被取走之前就结束了，它们从未进入上下文。 */
  | { type: 'queued_message_undelivered'; ids: string[]; reason: string }
  | {
      type: 'context_usage';
      usedTokens: number;
      windowTokens: number;
      source: 'api' | 'estimate';
    }
  | { type: 'error'; message: string }
  | { type: 'metrics'; metrics: ChatMessageMetrics }
  | { type: 'done'; finalText: string; metrics?: ChatMessageMetrics; circuitBroken?: boolean };

export interface ChatMessageMetrics {
  /** 本次回复所使用的具体模型标识 */
  model?: string;
  /** 本次生成总耗时（毫秒） */
  durationMs?: number;
  /** 首字延迟（Time to First Token，毫秒） */
  ttftMs?: number;
  /** 输出生成速度（Tokens 每秒） */
  tokensPerSecond?: number;
  /** 提示词/输入消耗的 Token 数 */
  promptTokens?: number;
  /** 生成/输出消耗的 Token 数 */
  completionTokens?: number;
  /** 总消耗的 Token 数 */
  totalTokens?: number;
  /** 本轮执行调用的工具总次数 */
  toolCallsCount?: number;
  /** 服务端停止原因（如 stop, tool_calls, length 等） */
  finishReason?: string;
}

export interface PendingDiff {
  id: string;
  path: string;
  original: string;
  modified: string;
  description?: string;
  originalTitle?: string;
  modifiedTitle?: string;
}

/** 「撤销本轮 AI 改动」的状态摘要。 */
export interface CheckpointSummary {
  runId: string;
  /** 本轮记录到的可回放操作数。 */
  mutations: number;
  /** 本轮涉及的不同文件数（去重后）。 */
  fileCount: number;
  /** 存在无法忠实留底的操作（二进制、超大目录），此时整轮拒绝撤销。 */
  incomplete: boolean;
  incompleteReason?: string;
  createdAt: number;
}

/** 单个文件的变动留底详情（供审查具体修改了哪些、如何回退）。 */
export interface CheckpointMutationDetail {
  kind: 'write' | 'delete' | 'move' | 'unrecordable';
  path: string;
  from?: string;
  to?: string;
  original: string | null;
  written: string | null;
  reason?: string;
}

/** 完整本轮快照详情，含所有文件的具体变动。 */
export interface CheckpointDetail extends CheckpointSummary {
  files: CheckpointMutationDetail[];
}

/**
 * 运行中追加给 Agent 的用户消息。
 *
 * 为什么不让渲染层直接调用 `startAgent` 再起一轮：Agent 正在跑的时候，工作区处在一个
 * 中间状态（改了一半的文件、还没验证的改动），新起一轮会拿到这个中间态当作起点。
 * 而「追加」是把它插进**当前这轮**的下一步之前，模型仍在同一条上下文里，能看到自己刚做了什么。
 */
export interface QueuedUserMessage {
  id: string;
  content: string;
  attachments?: ChatAttachment[];
}

export interface ConfirmRequest {
  id: string;
  title: string;
  detail: string;
  kind: 'terminal' | 'write' | 'delete' | 'other';
  /** 快捷选项（ask_user 交互选择） */
  options?: string[];
  /** 是否显示自由文本输入（ask_user） */
  allowInput?: boolean;
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeNode[];
}

export interface OpenTab {
  path: string;
  content: string;
  language: string;
  dirty: boolean;
  /** Custom display title for tab (e.g. read-only Git revision) */
  title?: string;
  /** Whether the tab is opened in read-only mode */
  readOnly?: boolean;
  /** 虚拟标签的附属数据（SQL 控制台的脚本落盘路径与会话目标、表结构视图的表定位） */
  virtual?: {
    scriptPath?: string;
    scriptTarget?: { connectionId: string; schemaName?: string };
    /**
     * `db://structure/` 标签要看的表。
     *
     * 路径里其实已经带了这三段（并能从路径解析出来），这里再存一份是因为
     * `EditorPane` 渲染时手上只有标签对象：解析路径要再引一次路径约定，
     * 而虚拟标签的元数据本来就是干这个的。
     */
    dbStructure?: { connectionId: string; schemaName?: string; tableName: string };
    /**
     * 内置浏览器虚拟标签元数据
     */
    browser?: {
      url: string;
      title?: string;
      favicon?: string;
      tabId?: string;
    };
  };
  /** Data URL for image preview tabs (png/jpg/…); content stays empty. */
  previewUrl?: string;
  /** Large file (>2MB): content is intentionally left empty to avoid editor stalls. */
  isLargeFile?: boolean;
}

/** 浏览器开发者模式下选中的 DOM 元素引用信息 */
export interface BrowserElementRef {
  url: string;
  pageTitle: string;
  tagName: string;
  id?: string;
  className?: string;
  selectorPath: string;
  /** 该选择器在页面中命中的元素数量；>1 表示选择器不唯一，仅用于提示，不阻断引用 */
  selectorMatchCount?: number;
  outerHtml: string;
  textContent: string;
  /** 元素在视口中的位置（CSS 像素），供主进程裁剪该元素的渲染截图 */
  rect?: { x: number; y: number; width: number; height: number };
  /** 关键计算样式摘要（display/flex/尺寸/颜色等），帮助 AI 判断布局问题 */
  computedStyles?: Record<string, string>;
  /** 祖先元素链（由外到内），让 AI 了解元素所处的容器结构 */
  ancestors?: Array<{ tagName: string; id?: string; className?: string }>;
  /** 同级兄弟摘要：元素在其父节点中的位置 */
  siblings?: { total: number; index: number; tags: string[] } | null;
  /** 元素渲染截图（data:image/png;base64,…），由主进程 capturePage 裁剪生成 */
  screenshotDataUrl?: string;
  timestamp: number;
}

/** 浏览器开发者模式下引用的整个页面信息 */
export interface BrowserPageRef {
  url: string;
  title: string;
  /** 引用时页面上最近捕获的控制台报错（最多 5 条） */
  errors?: string[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: 'image' | 'file' | 'browser-element' | 'browser-page';
  mimeType?: string;
  size?: number;
  /** For image: data URL (data:image/...;base64,...). */
  dataUrl?: string;
  /** For text/code file: text content. */
  content?: string;
  path?: string;
  /** For browser-element: detailed DOM element metadata */
  browserElement?: BrowserElementRef;
  /** For browser-page: 整个页面标签引用 */
  browserPage?: BrowserPageRef;
}

export interface ChatSessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachments?: ChatAttachment[];
  toolName?: string;
  toolCallId?: string;
  toolStatus?: 'running' | 'done' | 'error';
  toolArgs?: string;
  createdAt: number;
  /** True for intermediate reasoning messages before a tool call (not final answers) */
  isIntermediate?: boolean;
  /**
   * 发起这条用户消息的 Agent run。用来把「这一轮」和该轮的文件改动记录（checkpoint）对上，
   * 从而支持按轮撤销。历史会话里加载回来的旧消息没有这个字段 —— 那些轮次本来就撤销不了。
   */
  runId?: string;
  /**
   * 运行中追加的消息状态。
   * `queued` = 已提交但还没到步骤边界；`consumed` = 已进入模型上下文。
   * `undelivered` = 本轮在取走它之前就结束了，消息从未被模型看到（界面需提示用户重发）。
   */
  delivery?: 'queued' | 'consumed' | 'undelivered';
  /** 模型性能与延迟度量数据（TPS、耗时、TTFT、Token 计数等） */
  metrics?: ChatMessageMetrics;
  /**
   * 这条回复是「思考死循环熔断」的产物，没有有效内容。
   *
   * 回灌历史时要跳过它：把一句熔断报错塞进上下文，会诱导模型接着复读，形成二次死循环。
   * **判定必须走这个标志位，不能去比对 content 里的中文句子** —— 那句话一旦改措辞，
   * 熔断消息就会被当成正常回复回灌，而症状（下一轮又开始复读）离原因很远，很难查。
   */
  circuitBroken?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  customTitle?: boolean;
  messages: ChatSessionMessage[];
  updatedAt: number;
  /** Stable workspace key: local abs path, or SSH label `ssh user@host:/path`. */
  workspacePath?: string;
  /** Folder / project display name (without host). */
  projectName?: string;
  workspaceKind?: WorkspaceKind;
  /** Git branch at the time of conversation. */
  gitBranch?: string;
  /** Number of messages in this session. */
  messageCount?: number;
  /** Brief snippet/preview text for list view. */
  snippet?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: 'workspace' | 'user';
  path: string;
}

export interface GitCloneRequest {
  url: string;
  branch?: string;
  parentDir: string;
}

export interface GitCloneResult {
  ok: boolean;
  path?: string;
  detail: string;
}

/** Short status letter used in Source Control UI. */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?' | '!';

export interface GitStatusEntry {
  path: string;
  /** Index (staged) status letter, space if none. */
  index: string;
  /** Working tree status letter, space if none. */
  workTree: string;
  staged: boolean;
  untracked: boolean;
  ignored?: boolean;
}

export interface GitStatusResult {
  ok: boolean;
  detail?: string;
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  ignoredPaths?: string[];
  isShallow?: boolean;
}

export interface GitDiffResult {
  ok: boolean;
  detail?: string;
  path: string;
  original: string;
  modified: string;
  staged: boolean;
  isTracked?: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  lastCommit?: {
    hash: string;
    message: string;
    relativeDate: string;
    author: string;
  };
}

export interface GitCommitStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail?: string;
  date: string;
  relativeDate?: string;
  fullDate?: string;
  timestamp?: number;
  message: string;
  body?: string;
  parents?: string[];
  stats?: GitCommitStats;
}

export interface GitCommitFileChange {
  path: string;
  status: 'M' | 'A' | 'D' | 'R';
}

export interface GitCommitDetailResult {
  ok: boolean;
  detail?: string;
  commit?: GitCommitEntry;
  files: GitCommitFileChange[];
  stats?: GitCommitStats;
}

export interface GitHistoryOptions {
  maxCount?: number;
  all?: boolean;
  branch?: string;
}

export interface GitHistoryResult {
  ok: boolean;
  detail?: string;
  commits: GitCommitEntry[];
  emptyRepo?: boolean;
  isShallow?: boolean;
}

export interface GitBlameLineResult {
  ok: boolean;
  detail?: string;
  commit?: GitCommitEntry;
  line?: number;
}

export interface GitBlameEntry {
  line: number;
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  relativeDate: string;
  message: string;
}

export interface GitBlameFileResult {
  ok: boolean;
  entries?: GitBlameEntry[];
  detail?: string;
}

export interface GitOpResult {
  ok: boolean;
  detail: string;
}

export interface GitRemoteInfo {
  name: string;
  url: string;
}

export interface GitRemotesResult {
  ok: boolean;
  detail?: string;
  remotes: GitRemoteInfo[];
}

export interface GitStashEntry {
  index: number;
  message: string;
}

export type GitStashAction = 'push' | 'pop' | 'apply' | 'drop' | 'list';

export interface GitStashResult {
  ok: boolean;
  detail?: string;
  stashes?: GitStashEntry[];
}

export interface GitTagsResult {
  ok: boolean;
  detail?: string;
  tags: string[];
}

export interface GitOutputResult {
  ok: boolean;
  detail?: string;
  lines: string[];
}

export interface RecentWorkspaceItem {
  path: string;
  name: string;
  lastOpenedAt: number;
  kind?: 'local' | 'ssh';
  sshServer?: string;
  techStack?: string;
  gitBranch?: string;
  uncommittedCount?: number;
}

export interface DatabaseConnectionInfo {
  id: string;
  name: string;
  type: 'sqlite' | 'mysql' | 'postgres';
  path?: string;
  host?: string;
  port?: number;
  database?: string;
  connectedAt: number;
}

/**
 * 落盘到 `~/.echoly/projects/<工作区哈希>/db-connections.json` 的连接配置。
 *
 * 与 `DatabaseConnectionInfo` 刻意分开：那个描述的是「此刻正连着的会话」，本类型描述的是
 * 「这个项目保存了哪些连接」。id 由连接参数派生（见 databaseService.makeSavedId），
 * 因此同一份配置在多次会话之间保持同一个 id。
 */
export interface DbSavedConnection {
  id: string;
  name: string;
  type: 'sqlite' | 'mysql' | 'postgres';
  /** SQLite 数据库文件路径 */
  path?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** safeStorage 加密后的密码（`enc:v1:` 前缀）；环境不支持加密时降级为明文 */
  password?: string;
  updatedAt: number;
}

/** 传给渲染层的连接视图：项目里保存的配置 + 当前是否已连上 */
export interface DbConnectionView extends DbSavedConnection {
  connected: boolean;
  /**
   * `connected` 只是「此刻是否有会话」的结果，会因切工作区时主进程先断连而短暂为 false，
   * 此时点一下通常能连上。这里用两个标记把「点了能不能连上」说清楚：
   * - `passwordSaved`: 配置里存了密码 → 点击即可自动重连
   * - `requiresPassword`: 配置里没存密码 → 点击需先补密码（走「编辑连接…」）
   */
  passwordSaved?: boolean;
  requiresPassword?: boolean;
}

export interface DatabaseColumnMeta {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: any;
  pk: boolean;
  /**
   * 数据库里的列注释。
   *
   * MySQL 取自 `information_schema.columns.COLUMN_COMMENT`，PostgreSQL 取自 `pg_description`；
   * **SQLite 没有列注释这个概念，恒为 null**（不编造）。缺失 / 空串都表示「没有注释」，
   * 消费方据此决定要不要渲染那一行。
   */
  comment?: string | null;
  /**
   * 该列的额外属性原文（图4 的「Extra」列）。
   *
   * MySQL 取自 `information_schema.columns.EXTRA`（`auto_increment`、`on update CURRENT_TIMESTAMP`、
   * `VIRTUAL GENERATED` 等）；PostgreSQL / SQLite 没有等价概念，为 null。
   *
   * 存在的理由：自增标记只能从这里读出来。表结构视图若拿不到它，
   * 就会把一个自增主键当成普通列回写 `MODIFY`，把 AUTO_INCREMENT 属性悄悄抹掉。
   */
  extra?: string | null;
}

/** 库 / Schema 节点：MySQL 下是 database，PostgreSQL 下是 schema，SQLite 下是附加库（main 等） */
export interface DatabaseSchemaInfo {
  name: string;
  kind: 'database' | 'schema';
  tableCount?: number;
}

export interface DatabaseTableInfo {
  name: string;
  rowCount?: number;
  comment?: string;
  columns?: DatabaseColumnMeta[];
  /**
   * 这个条目究竟是哪种对象。
   *
   * 树上需要把「表」和「视图」分开展示（各自一个分组节点），而重建视图的语句与表并不相同。
   * 缺省视为 `table`：老调用方（以及只关心表的地方）不必逐个补齐这个字段。
   */
  kind?: 'table' | 'view';
}

/** 库 / schema 展开后的六个分组 */
export type DbObjectGroup = 'tables' | 'views' | 'indexes' | 'procedures' | 'triggers' | 'events';

/**
 * 一个库 / schema 下的对象清单，按树上要展示的分组切开。
 *
 * 每类都是一个扁平的名字数组 —— 树上就是照名字列的，不需要更细的元数据；
 * 真正需要细节时（列、DDL）再单独去取，免得展开一个库就要把全库的对象都读一遍。
 */
export interface DbSchemaObjects {
  tables: string[];
  views: string[];
  indexes: string[];
  procedures: string[];
  triggers: string[];
  events: string[];
  /** 该驱动是否支持这一组。为 false 时树上显示「不支持」并置灰，而不是伪装成「空」 */
  supported: Record<DbObjectGroup, boolean>;
  /** 单组的错误（某类查询失败不该拖垮整个展开），键即组名 */
  errors?: Partial<Record<DbObjectGroup, string>>;
}

export interface DatabaseQueryResult {
  ok: boolean;
  columns: string[];
  rows: Record<string, any>[];
  total?: number;
  affectedRows?: number;
  executionTimeMs: number;
  error?: string;
}

/** 批量事务里单条语句的执行结果 */
export interface DbBatchStatementResult {
  sql: string;
  ok: boolean;
  affectedRows?: number;
  error?: string;
}

/**
 * 批量事务执行结果。
 *
 * 与 `DatabaseQueryResult` 刻意分开：批次只跑 DML（增删改行），不返回结果集，
 * 且要把「第几条成功、第几条失败」逐条带回来，供数据视图在失败时保留暂存态。
 */
export interface DbBatchResult {
  ok: boolean;
  results: DbBatchStatementResult[];
  /**
   * 事务是否真的回滚成功（仅在 `ok === false` 时有意义）。
   * 回滚本身也可能失败（例如连接已断），此时置 false 并在 `error` 里说明 ——
   * 用户需要知道「数据可能处于半改状态」，不能只看到一句「失败」。
   */
  rolledBack?: boolean;
  executionTimeMs: number;
  error?: string;
}

export interface SearchFileHit {
  path: string;
  score?: number;
}

export interface SearchCodeHit {
  path: string;
  line: number;
  preview: string;
}

export interface SearchCodeRequest {
  query: string;
  glob?: string;
  caseInsensitive?: boolean;
  max?: number;
}

export type WorkspaceKind = 'local' | 'ssh';

/**
 * 未打开工作区时 `WorkspaceInfo.label` 的哨兵值。
 *
 * 主进程设置它、渲染进程要靠它判断「是不是真的没有工作区」（标题栏、项目名、
 * 会话元数据都要区分「工作区名叫未打开工作区」和「压根没打开」）。两边各写一份
 * 字面量迟早会分叉，而分叉的表现是标题栏显示出一个假的项目名 —— 不报错，只是不对。
 *
 * 注意：这只是**内部哨兵**，不是给用户看的文案。界面上要显示时用 i18n 的
 * `panel.noWorkspace`。
 */
export const NO_WORKSPACE_LABEL = '未打开工作区';

export interface WorkspaceInfo {
  kind: WorkspaceKind;
  root: string | null;
  label: string;
}

export interface SshConnectRequest {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  remotePath?: string;
  saveProfile?: boolean;
  profileName?: string;
  browseOnly?: boolean;
}

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  remotePath?: string;
}

export interface SshConnectResult {
  ok: boolean;
  root?: string;
  label?: string;
  detail: string;
  /**
   * 失败原因是否为「macOS 本地网络隐私授权未放行」。
   *
   * 渲染层要据此决定是否显示「打开系统设置」按钮。**必须走这个显式标志位**：
   * 原先渲染层是拿 `detail.includes('本地网络')` 判断的，而 detail 是给人看的文案，
   * 一旦翻译或改写，按钮就会静默消失 —— 失败的还是同一次失败，只是用户再也点不到补救入口。
   */
  needsLocalNetwork?: boolean;
}

export interface RemoteDirEntry {
  name: string;
  isDirectory: boolean;
  path: string;
}

export interface TerminalCreateOptions {
  kind?: 'local' | 'ssh';
  /** Relative workspace path used as shell cwd (directories preferred). */
  cwd?: string;
  cols?: number;
  rows?: number;
}

export type AppMenuId = 'edit' | 'view' | 'window';

export type MenuCommand =
  | { type: 'save' }
  | { type: 'saveAs' }
  | { type: 'saveAll' }
  | { type: 'revertFile' }
  | { type: 'closeWorkspace' }
  | { type: 'autoSave'; enabled: boolean }
  | { type: 'toggleWordWrap'; enabled: boolean }
  | { type: 'newFile' }
  | { type: 'closeEditor' }
  | { type: 'openWorkspaceModal' }
  | { type: 'openWorkspace'; path: string };

export interface IpcApi {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  pickWorkspace: () => Promise<string | null>;
  openNewWindow: (targetPath?: string, sshAuth?: any) => Promise<void>;
  getSshAuthHandoff: (token: string) => Promise<any>;
  getWorkspace: () => Promise<string | null>;
  getWorkspaceInfo: () => Promise<WorkspaceInfo>;
  setWorkspace: (root: string) => Promise<string>;
  listDir: (relPath?: string) => Promise<FileTreeNode[]>;
  readFile: (relPath: string) => Promise<string>;
  /** 流式/分页读取指定行区间，用于大文件极速安全预览与防卡顿加载 */
  readFileLines: (
    relPath: string,
    offset?: number,
    limit?: number,
  ) => Promise<{ lines: string[]; total: number; offset: number; truncated: boolean }>;
  /** Read binary file as a data URL (used for image preview). */
  readFileDataUrl: (relPath: string) => Promise<string>;
  writeFile: (relPath: string, content: string) => Promise<void>;
  mkdir: (relPath: string) => Promise<void>;
  renamePath: (fromRel: string, toRel: string) => Promise<void>;
  removePath: (relPath: string) => Promise<void>;
  copyPath: (fromRel: string, toRel: string) => Promise<void>;
  pathExists: (relPath: string) => Promise<boolean>;
  resolveAbsolutePath: (relPath?: string) => Promise<string>;
  // ── 项目配置（数据库连接 / 查询脚本） ──────────────────────────────────────
  //
  // 这些内容**不写进工作区**，而是落在用户主目录的项目配置目录
  // （`~/.echoly/projects/<工作区哈希>/`）。参数与工作区文件接口同形：传的都是
  // 工作区相对的 POSIX 路径，由主进程映射到配置目录。
  //
  // 为什么要单开一组而不是复用 readFile/writeFile：那组走的是工作区后端，SSH 工作区
  // 下会写到远端去；而这些文件始终在**用户自己这台机器**上，与工作区是本地还是远端无关。
  /** 读配置目录里的文件；不存在返回 null（配置永远是可选的） */
  readProjectConfigFile: (relPath: string) => Promise<string | null>;
  /** 写配置目录里的文件，父目录自动创建 */
  writeProjectConfigFile: (relPath: string, content: string) => Promise<void>;
  /** 列配置目录下的子项 */
  listProjectConfigDir: (
    relPath?: string,
  ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
  /** 删除配置目录里的一个文件 */
  removeProjectConfigFile: (relPath: string) => Promise<void>;
  detectWorkspaceTech?: (rootPath: string) => Promise<string>;
  downloadFile: (relPath: string) => Promise<string | null>;
  saveFileDialog: (defaultPath?: string) => Promise<string | null>;
  pickDirectory: () => Promise<string | null>;
  createProjectFromTemplate: (params: {
    templateId: string;
    parentDir: string;
    projectName: string;
  }) => Promise<{ ok: boolean; targetPath?: string; entryFile?: string; error?: string }>;
  pickFile: (filters?: { name: string; extensions: string[] }[]) => Promise<string | null>;
  startAgent: (payload: {
    prompt: string;
    sessionId?: string;
    mode?: AgentMode;
    modelId?: string;
    planContext?: PlanContext;
    openFiles?: Array<{ path: string; content: string }>;
    selection?: string;
    cursor?: { path: string; line: number; column: number };
    history?: ChatMessage[];
    attachments?: ChatAttachment[];
  }) => Promise<{ runId: string }>;
  cancelAgent: (runId: string) => Promise<void>;
  /**
   * 向正在运行的一轮追加一条用户消息。返回 `false` 表示该轮已结束，
   * 调用方应改为发起新一轮（而不是把消息丢掉）。
   */
  queueAgentMessage: (runId: string, message: QueuedUserMessage) => Promise<boolean>;
  respondConfirm: (requestId: string, approved: boolean, answer?: string) => Promise<void>;
  continueAgent: (runId: string) => Promise<void>;
  stopContinueAgent: (runId: string) => Promise<void>;
  acceptDiff: (diffId: string) => Promise<void>;
  rejectDiff: (diffId: string) => Promise<void>;
  acceptAllDiffs: () => Promise<void>;
  rejectAllDiffs: () => Promise<void>;
  /**
   * 本轮 AI 改动的写前记录摘要（用于「撤销本轮 AI 改动」按钮的可用性判断）。
   * 没有记录时返回 `null`。
   */
  getCheckpointSummary: (runId?: string) => Promise<CheckpointSummary | null>;
  /** 获取本轮改动的完整文件清单与 Diff 详情，供细粒度审查与自选回退 */
  getCheckpointDetail: (runId?: string) => Promise<CheckpointDetail | null>;
  /**
   * 撤销一轮 AI 的全部或指定文件改动。返回被还原的路径，以及因冲突/无法留底而跳过的部分 ——
   * 调用方必须把跳过项告诉用户，否则「撤销成功」会成为一句谎话。
   */
  revertCheckpoint: (
    runId?: string,
    options?: { paths?: string[]; force?: boolean },
  ) => Promise<
    | {
        runId: string;
        reverted: string[];
        conflicts: string[];
        skipped: Array<{ path: string; reason: string }>;
      }
    | { error: string }
  >;
  listSessions: () => Promise<ChatSession[]>;
  getSession: (id: string) => Promise<ChatSession | null>;
  saveSession: (session: ChatSession) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  probeLlm: (options?: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    provider?: string;
  }) => Promise<{ ok: boolean; detail: string; models?: string[] }>;
  quickPrompt: (payload: {
    userPrompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ text: string }>;
  completeCode: (payload: {
    prefix: string;
    suffix: string;
    language?: string;
  }) => Promise<{ completion: string }>;
  listSkills: () => Promise<SkillInfo[]>;
  openUserSkillsDir: () => Promise<string>;
  /** 读工作区与用户目录下的自定义命令（`.echoly/commands` 等）。 */
  listCommands: () => Promise<SlashCommandInfo[]>;
  /** 重载 MCP 服务器：读设置、连接、返回各服务器状态。设置变更后调用。 */
  mcpReload: () => Promise<McpServerStatus[]>;
  mcpStatus: () => Promise<McpServerStatus[]>;
  rulesGet: (
    workspaceRoot?: string,
  ) => Promise<{ ok: boolean; content?: string | null; filename?: string }>;
  rulesSave: (content: string, workspaceRoot?: string) => Promise<{ ok: boolean }>;
  cloneRepo: (req: GitCloneRequest) => Promise<GitCloneResult>;
  gitInit: () => Promise<GitOpResult>;
  gitStatus: () => Promise<GitStatusResult>;
  gitStage: (paths: string[]) => Promise<GitOpResult>;
  gitUnstage: (paths: string[]) => Promise<GitOpResult>;
  gitCommit: (message: string, amend?: boolean) => Promise<GitOpResult>;
  gitDiscard: (paths: string[]) => Promise<GitOpResult>;
  gitDiff: (path: string, staged?: boolean) => Promise<GitDiffResult>;
  gitBranches: () => Promise<{
    ok: boolean;
    detail?: string;
    branches: GitBranchInfo[];
    tags?: string[];
  }>;
  gitCheckout: (branch: string) => Promise<GitOpResult>;
  gitCreateBranch: (name: string, checkout?: boolean) => Promise<GitOpResult>;
  gitPull: () => Promise<GitOpResult>;
  gitPush: () => Promise<GitOpResult>;
  gitFetch: () => Promise<GitOpResult>;
  gitRemotes: () => Promise<GitRemotesResult>;
  gitStash: (action: GitStashAction, message?: string) => Promise<GitStashResult>;
  gitTags: () => Promise<GitTagsResult>;
  gitCreateTag: (name: string, message?: string) => Promise<GitOpResult>;
  gitOutput: (maxCount?: number) => Promise<GitOutputResult>;
  gitHistory: (options?: number | GitHistoryOptions) => Promise<GitHistoryResult>;
  gitCommitDetails: (hash: string) => Promise<GitCommitDetailResult>;
  gitFileHistory: (path: string, maxCount?: number) => Promise<GitHistoryResult>;
  gitBlameLine: (path: string, line: number) => Promise<GitBlameLineResult>;
  gitBlameFile: (path: string) => Promise<GitBlameFileResult>;
  gitShowCommitDiff: (hash: string, path: string) => Promise<GitDiffResult>;
  gitShowFileAtRef: (
    ref: string,
    path: string,
  ) => Promise<{ ok: boolean; content?: string; detail?: string }>;
  gitDiffWithRef: (ref: string, path: string) => Promise<GitDiffResult>;
  gitCompareBranches: (
    baseRef: string,
    targetRef: string,
  ) => Promise<{
    ok: boolean;
    ahead: number;
    behind: number;
    files: { status: string; path: string }[];
    detail?: string;
  }>;
  gitDiffBetweenRefs: (baseRef: string, targetRef: string, path: string) => Promise<GitDiffResult>;
  gitGenerateCommitMessage: () => Promise<{ ok: boolean; message?: string; detail?: string }>;
  gitGeneratePrSummary: (
    targetBranch?: string,
  ) => Promise<{ ok: boolean; summary?: string; detail?: string }>;
  projectGetMemory: () => Promise<{ ok: boolean; memory?: string }>;
  projectSaveMemory: (memory: string) => Promise<{ ok: boolean }>;

  searchFiles: (query: string, max?: number) => Promise<SearchFileHit[]>;
  resolveFilePath: (fileNameOrPath: string) => Promise<string | null>;
  searchCode: (req: SearchCodeRequest) => Promise<SearchCodeHit[]>;
  sshConnect: (req: SshConnectRequest) => Promise<SshConnectResult>;
  sshDisconnect: () => Promise<void>;
  sshDisconnectBrowse: () => Promise<void>;
  sshSwitchRemotePath: (
    remotePath: string,
  ) => Promise<{ ok: boolean; detail?: string; root?: string; label?: string }>;
  sshGetActiveSession: () => Promise<{
    host: string;
    port: number;
    username: string;
    remoteRoot: string;
  } | null>;
  listSshProfiles: () => Promise<SshProfile[]>;
  listLocalSshConfig: () => Promise<SshProfile[]>;
  saveSshProfile: (
    profile: Partial<SshProfile> & { host: string; username: string },
  ) => Promise<void>;
  deleteSshProfile: (id: string) => Promise<void>;
  listRemoteDir: (
    remotePath?: string,
  ) => Promise<{ ok: boolean; entries?: RemoteDirEntry[]; currentPath?: string; detail?: string }>;
  startSshPortForward: (
    remotePort: number,
    localPort?: number,
  ) => Promise<{ ok: boolean; localPort: number; error?: string }>;
  stopSshPortForward: (remotePort: number) => Promise<{ ok: boolean }>;
  listSshPortForwards: () => Promise<Array<{ remotePort: number; localPort: number }>>;
  dbConnect: (options: {
    path?: string;
    name?: string;
    type?: 'sqlite' | 'mysql' | 'postgres';
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    username?: string;
    password?: string;
  }) => Promise<{ ok: boolean; connection?: DatabaseConnectionInfo; error?: string }>;
  dbDisconnect: (connectionId: string) => Promise<{ ok: boolean }>;
  /** 当前工作区（项目）里保存的连接配置 + 各自的连接状态 */
  dbListConnections: () => Promise<DbConnectionView[]>;
  /** 新增 / 更新一条连接配置（写盘到 ~/.echoly/projects/<工作区哈希>/db-connections.json） */
  dbSaveConnection: (
    config: Omit<Partial<DbSavedConnection>, 'password'> & { password?: string },
  ) => Promise<{ ok: boolean; connection?: DbSavedConnection; error?: string }>;
  /** 删除一条连接配置（若正连着会先断开） */
  dbDeleteConnection: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 用已保存的配置（含密码）重新连接 */
  dbConnectSaved: (
    id: string,
  ) => Promise<{ ok: boolean; connection?: DatabaseConnectionInfo; error?: string }>;
  /** 列出连接下的库 / schema（MySQL: SHOW DATABASES；PG: information_schema.schemata；SQLite: PRAGMA database_list） */
  dbListSchemas: (
    connectionId: string,
  ) => Promise<{ ok: boolean; schemas: DatabaseSchemaInfo[]; error?: string }>;
  dbListTables: (
    connectionId: string,
    schemaName?: string,
  ) => Promise<{ ok: boolean; tables: DatabaseTableInfo[]; error?: string }>;
  dbGetTableSchema: (
    connectionId: string,
    tableName: string,
    schemaName?: string,
  ) => Promise<{ ok: boolean; columns: DatabaseColumnMeta[]; error?: string }>;
  dbGetTableDdl: (
    connectionId: string,
    tableName: string,
    schemaName?: string,
  ) => Promise<{ ok: boolean; ddl?: string; error?: string }>;
  /**
   * 库 / schema 下的各类对象分布（表、视图、索引、存储过程、触发器、事件）。
   *
   * 与 `dbListTables` 分开：后者是数据浏览的主路径（要行数、要快），
   * 而这里要的是一次把六个分组都拿齐 —— 树上一个库展开时就该看到完整分类，
   * 而不是先只看表、别的等用户点开才知道有没有。
   */
  dbListObjects: (
    connectionId: string,
    schemaName?: string,
  ) => Promise<{ ok: boolean; objects?: DbSchemaObjects; error?: string }>;
  dbQuery: (
    connectionId: string,
    sql: string,
    page?: number,
    pageSize?: number,
    schemaName?: string,
  ) => Promise<DatabaseQueryResult>;
  dbCreateDemoDb: (targetPath?: string) => Promise<{
    ok: boolean;
    path: string;
    connection: DatabaseConnectionInfo;
    error?: string;
  }>;
  /**
   * 在一个事务里顺序执行多条语句（DML 专用）。
   *
   * 为什么只有这个方法带事务、DDL 不走它：MySQL 的 DDL 会**隐式提交**当前事务，
   * 把 CREATE/ALTER/DROP 混进批次会静默破坏原子性，所以表结构变更一律单条走 `dbQuery`。
   * 批次里若出现 BEGIN / COMMIT 等事务控制语句会被直接拒绝（见主进程实现）。
   */
  dbExecuteBatch: (
    connectionId: string,
    statements: string[],
    schemaName?: string,
  ) => Promise<DbBatchResult>;
  createTerminal: (options?: TerminalCreateOptions) => Promise<{ id: string }>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  disposeTerminal: (id: string) => Promise<void>;
  popupMenu: (id: AppMenuId) => Promise<void>;
  onMenuCommand: (cb: (command: MenuCommand) => void) => () => void;
  onAgentEvent: (cb: (event: AgentEvent & { runId: string }) => void) => () => void;
  onTerminalData: (cb: (payload: { id: string; data: string }) => void) => () => void;
  onTerminalExit: (cb: (payload: { id: string; exitCode: number }) => void) => () => void;
  onWorkspaceChanged: (cb: (info: WorkspaceInfo) => void) => () => void;
  onFsChanged?: (cb: (data: { type: string; path?: string }) => void) => () => void;
  onGitCloneLog: (cb: (line: string) => void) => () => void;
  onGitBranchSwitched: (cb: (data: { branch: string }) => void) => () => void;
  onDownloadProgress: (
    cb: (progress: { percent: number; downloaded: number; total: number }) => void,
  ) => () => void;
  onExtensionWebviewRegistered: (cb: (data: { viewId: string }) => void) => () => void;
  extensionResolveWebview: (
    viewId: string,
  ) => Promise<{ success: boolean; html?: string; filePath?: string; error?: string }>;
  /** 检查更新（仅探测，不下载）。返回是否需更新 + 版本说明。 */
  checkUpdate: () => Promise<{
    ok: boolean;
    hasUpdate?: boolean;
    version?: string;
    current?: string;
    releaseNotes?: string;
    detail?: string;
  }>;
  /** 确认后下载并安装：下载 → 打开安装包 → 退出当前应用。 */
  downloadUpdate: () => Promise<{ ok: boolean; detail?: string }>;
  /** 获取更新状态 */
  getUpdateState: () => Promise<{ checked: boolean; feed: unknown }>;
  /** 更新下载进度事件：phase=download 时带 loaded/total/percent */
  onUpdateProgress: (
    cb: (progress: {
      phase: 'download' | 'done';
      loaded: number;
      total: number;
      percent: number;
    }) => void,
  ) => () => void;

  /** LSP 语言服务器跳转到定义 */
  lspGetDefinition: (filePath: string, line: number, column: number) => Promise<LspLocation[]>;
  /** LSP 语言服务器代码补全 */
  lspGetCompletion?: (
    filePath: string,
    line: number,
    column: number,
  ) => Promise<LspCompletionItem[]>;
  /** LSP 语言服务器同步文档内容 */
  lspNotifyDocument: (filePath: string, content: string, languageId?: string) => Promise<void>;
  /** LSP C/C++ 头文件与源文件快速切换 (Alt+O) */
  lspSwitchSourceHeader?: (filePath: string) => Promise<string | null>;
  /** 监听 LSP 实时语法诊断 (波浪线) */
  onLspDiagnostics?: (cb: (data: LspDiagnosticsEvent) => void) => () => void;

  /** 检测系统 C/C++ 工具链状态 (编译器, Clangd, 调试器, CMake) */
  cppCheckToolchain?: () => Promise<CppToolchainStatus>;

  /** 检测系统多语言开发与调试工具链状态 (Python, Go, Node.js 等) */
  multiLangCheckToolchain?: () => Promise<MultiLangToolchainStatus>;

  /** DAP 调试会话管理 */
  dapStartSession?: (config: {
    program: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    stopOnEntry?: boolean;
    mode?: 'stdio' | 'socket';
    host?: string;
    port?: number;
    language?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  dapStopSession?: () => Promise<void>;
  dapSetBreakpoints?: (
    filePath: string,
    breakpoints: Array<number | { line: number; condition?: string; logMessage?: string }>,
  ) => Promise<DapBreakpoint[]>;
  dapContinue?: () => Promise<void>;
  dapStepOver?: () => Promise<void>;
  dapStepInto?: () => Promise<void>;
  dapStepOut?: () => Promise<void>;
  dapPause?: () => Promise<void>;
  dapGetThreads?: () => Promise<DapThread[]>;
  dapGetStackTrace?: (threadId: number) => Promise<DapStackFrame[]>;
  dapGetScopes?: (frameId: number) => Promise<DapScope[]>;
  dapGetVariables?: (variablesReference: number) => Promise<DapVariable[]>;
  dapEvaluate?: (
    expression: string,
    frameId?: number,
  ) => Promise<{ result: string; type?: string }>;
  onDapEvent?: (cb: (event: DapEvent) => void) => () => void;

  /** 在访达/资源管理器中显示指定文件 */
  showItemInFolder: (fullPath: string) => Promise<void>;

  /** 检测 Maven 环境 */
  mavenCheckEnv: () => Promise<MavenEnvironmentInfo>;
  /** 一键在当前工作区生成 Maven Wrapper (mvnw) */
  mavenInitWrapper: () => Promise<{ success: boolean; message: string }>;
  /** 一键在当前工作区生成包含阿里云加速镜像的 settings.xml */
  mavenInitSettings: () => Promise<{ success: boolean; path?: string; message: string }>;

  /** 检测并列出本地已安装的 Java (JDK) */
  javaGetInstalledJdks: () => Promise<InstalledJdkInfo[]>;
  /** 获取可供在线安装的官方推荐 Java (JDK) 列表 */
  javaGetOnlineJdks: () => Promise<OnlineJdkInfo[]>;
  /** 在线下载并安装指定的 JDK */
  javaInstallOnlineJdk: (
    id: string,
  ) => Promise<{ success: boolean; javaHome?: string; message: string }>;
  /** 监听 JDK 在线下载与解压进度 */
  onJavaInstallProgress: (cb: (progress: JdkInstallProgress) => void) => () => void;
  /** 打开系统设置（如 macOS 本地网络隐私设置） */
  openSystemSettings?: (type?: string) => Promise<boolean>;
  /** 打开系统外部链接或本地网络服务 */
  openExternal?: (url: string) => Promise<boolean>;

  /** 代码库全局符号索引与 BM25 检索 */
  codebaseIndex: (force?: boolean) => Promise<CodebaseIndexStatus>;
  codebaseSearch: (query: string, limit?: number) => Promise<CodebaseSymbolHit[]>;
  codebaseStatus: () => Promise<CodebaseIndexStatus>;
  /** 索引进度推送；返回取消订阅函数。 */
  onCodebaseProgress?: (
    cb: (progress: NonNullable<CodebaseIndexStatus['progress']>) => void,
  ) => () => void;

  /**
   * 把渲染层 Monaco 的 markers 上报给主进程，供 Agent 的 get_diagnostics 工具读取。
   *
   * TS/JS 的语言服务只在渲染进程里，主进程 LSP 只覆盖 clangd/pyright/gopls，
   * 两边合起来才是模型看到的完整诊断视图。`entries` 是当前窗口的**全量快照**
   * （不是增量），空数组表示工作区已无诊断。
   */
  reportDiagnostics?: (entries: WorkspaceDiagnostic[]) => Promise<boolean>;

  /** 挂载/更新内置浏览器 DevTools 原生视图（bounds 为渲染层 CSS 像素，主进程负责换算 DIP） */
  openDevToolsView?: (targetWebContentsId: number, layout: DevToolsViewLayout) => Promise<boolean>;
  updateDevToolsViewBounds?: (
    targetWebContentsId: number,
    layout: DevToolsViewLayout,
  ) => Promise<boolean>;
  /**
   * 告知主进程是否正处于「上下拖动控制台高度」状态。
   * 拖动态下原生 WebContentsView 保持原位可见（挪走或隐藏都会让用户看到黑屏），
   * 只是暂缓按中途高度重排，拖动结束后再一次性落位。
   */
  setDevToolsDragging?: (targetWebContentsId: number, dragging: boolean) => Promise<boolean>;
  closeDevToolsView?: (targetWebContentsId: number) => Promise<boolean>;
  /**
   * 截取内置浏览器中某个 DOM 元素的渲染截图。
   * rect 为元素在页面视口中的 CSS 像素坐标（注入脚本 getBoundingClientRect 的结果），
   * 主进程负责换算 DIP 与设备像素后调用 capturePage。失败返回 null（元素已滚出视口等）。
   */
  captureBrowserElement?: (
    targetWebContentsId: number,
    rect: { x: number; y: number; width: number; height: number },
  ) => Promise<string | null>;
  /**
   * 订阅窗口缩放因子变化。
   * 原生 DevTools 视图的 Bounds 由 CSS 像素换算 DIP 得到，缩放后比例改变，渲染层需重新上报坐标。
   */
  onZoomChanged?: (cb: (zoom: number) => void) => () => void;
  /**
   * 订阅内置浏览器打开新标签页请求（如链接 target="_blank" 或 window.open）
   */
  onBrowserOpenTab?: (cb: (data: { url: string }) => void) => () => void;
}

/**
 * 内置浏览器 DevTools 原生视图的布局描述。
 * bounds：渲染层 CSS 像素坐标（getBoundingClientRect 的结果）。
 * 主进程会按窗口缩放因子换算为 DIP 后再交给 WebContentsView.setBounds，
 * 因此这里传 CSS 像素即可，无需渲染层自行缩放。
 * 拖动期间是否需要暂缓落位，由 setDevToolsDragging 单独告知，避免视图被移走导致黑屏。
 */
export interface DevToolsViewLayout {
  bounds: { x: number; y: number; width: number; height: number };
}

export interface CppToolItem {
  name: string;
  command: string;
  path?: string;
  version?: string;
  installed: boolean;
  installGuide?: string;
}

export interface CppToolchainStatus {
  compiler: CppToolItem;
  clangd: CppToolItem;
  debugger: CppToolItem;
  cmake: CppToolItem;
}

export interface MultiLangToolchainStatus {
  cpp: CppToolchainStatus;
  python: {
    interpreter: CppToolItem;
    debugpy: CppToolItem;
    pip: CppToolItem;
  };
  go: {
    go: CppToolItem;
    delve: CppToolItem;
    gopls: CppToolItem;
  };
  node: {
    node: CppToolItem;
    npm: CppToolItem;
    typescript: CppToolItem;
  };
}

export interface DapBreakpoint {
  id?: number;
  path: string;
  line: number;
  condition?: string;
  logMessage?: string;
  verified?: boolean;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
}

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number; // 1: Error, 2: Warning, 3: Information, 4: Hint
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspDiagnosticsEvent {
  uri: string;
  path: string;
  diagnostics: LspDiagnostic[];
}

export interface DapThread {
  id: number;
  name: string;
}

export interface DapStackFrame {
  id: number;
  name: string;
  source?: {
    path?: string;
    name?: string;
  };
  line: number;
  column: number;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive?: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export type DapEventType =
  'stopped' | 'continued' | 'output' | 'terminated' | 'exited' | 'breakpoint';

export interface DapEvent {
  type: DapEventType;
  reason?: string;
  threadId?: number;
  hitBreakpointIds?: number[];
  category?: string;
  output?: string;
  exitCode?: number;
}

export interface InstalledJdkInfo {
  id: string;
  version: string;
  majorVersion?: number;
  arch?: string;
  vendor?: string;
  path: string;
  isCurrent?: boolean;
}

export interface OnlineJdkInfo {
  id: string;
  name: string;
  version: string;
  vendor: string;
  description?: string;
  recommended?: boolean;
  sizeMb?: number;
  downloadUrl: string;
  isInstalled?: boolean;
  installedPath?: string;
}

export interface JdkInstallProgress {
  id: string;
  status: 'downloading' | 'extracting' | 'done' | 'error';
  percent: number;
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface MavenEnvironmentInfo {
  available: boolean;
  type: 'wrapper' | 'system' | 'detected' | 'none';
  executablePath: string;
  hasJava: boolean;
  mavenVersion?: string;
  javaVersion?: string;
  detail?: string;
}

export interface LspLocation {
  path: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export * from './projectTemplates';

export interface CodebaseSymbolHit {
  filePath: string;
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'doc';
  line: number;
  endLine: number;
  content: string;
  doc?: string;
  score: number;
}

export interface CodebaseIndexStatus {
  indexedFiles: number;
  totalSymbols: number;
  lastIndexedTime: number;
  isIndexing: boolean;
  /** 当前/最近一次索引的进度。索引可能跑几十秒，没有它界面上只能转圈。 */
  progress?: {
    phase: 'scan' | 'read' | 'save' | 'done';
    scanned: number;
    total: number;
    /** 本轮复用旧索引的文件数（增量更新的效果）。 */
    reused: number;
  };
}

/** 一条工作区诊断（Monaco marker / LSP diagnostic 归一化后的形态），供 Agent 自检使用。 */
export interface WorkspaceDiagnostic {
  path: string;
  line: number;
  column?: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

declare global {
  interface Window {
    ide: IpcApi;
  }
}
