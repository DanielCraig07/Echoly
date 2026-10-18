export const APP_VERSION = '0.0.45';
export const DEFAULT_LLM_BASE_URL = 'http://192.168.10.241:8002';
export const DEFAULT_LLM_MODEL = 'deepseek-v4-flash';

/** AI Provider types */
export type AiProvider = 'openai' | 'anthropic' | 'deepseek' | 'custom';
export type ModelProviderType = AiProvider;

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
  enableThinking?: boolean;
  thinkingTokens?: number;
  isDefault?: boolean;
  lastProbeOk?: boolean;
}

export const DEFAULT_MODELS: ModelProfile[] = [
  {
    id: 'deepseek-local',
    name: 'DeepSeek (内网部署)',
    provider: 'deepseek',
    baseUrl: 'http://192.168.10.241:8002',
    model: 'deepseek-v4-flash',
    apiKey: '',
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
}

export const DEFAULT_PROVIDERS: Record<AiProvider, Omit<ProviderConfig, 'apiKey'>> = {
  deepseek: {
    provider: 'deepseek',
    baseUrl: 'http://192.168.10.241:8002',
    model: 'deepseek-v4-flash',
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
};

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
        model: base.providers.deepseek.model || 'deepseek-v4-flash',
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
  | {
      type: 'context_usage';
      usedTokens: number;
      windowTokens: number;
      source: 'api' | 'estimate';
    }
  | { type: 'error'; message: string }
  | { type: 'done'; finalText: string };

export interface PendingDiff {
  id: string;
  path: string;
  original: string;
  modified: string;
  description?: string;
  originalTitle?: string;
  modifiedTitle?: string;
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
export type DbObjectGroup =
  | 'tables'
  | 'views'
  | 'indexes'
  | 'procedures'
  | 'triggers'
  | 'events';

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
  respondConfirm: (requestId: string, approved: boolean, answer?: string) => Promise<void>;
  continueAgent: (runId: string) => Promise<void>;
  stopContinueAgent: (runId: string) => Promise<void>;
  acceptDiff: (diffId: string) => Promise<void>;
  rejectDiff: (diffId: string) => Promise<void>;
  acceptAllDiffs: () => Promise<void>;
  rejectAllDiffs: () => Promise<void>;
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
  rulesGet: (workspaceRoot?: string) => Promise<{ ok: boolean; content?: string | null; filename?: string }>;
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
  gitShowFileAtRef: (ref: string, path: string) => Promise<{ ok: boolean; content?: string; detail?: string }>;
  gitDiffWithRef: (ref: string, path: string) => Promise<GitDiffResult>;
  gitCompareBranches: (baseRef: string, targetRef: string) => Promise<{
    ok: boolean;
    ahead: number;
    behind: number;
    files: { status: string; path: string }[];
    detail?: string;
  }>;
  gitDiffBetweenRefs: (baseRef: string, targetRef: string, path: string) => Promise<GitDiffResult>;
  gitGenerateCommitMessage: () => Promise<{ ok: boolean; message?: string; detail?: string }>;

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
  lspGetCompletion?: (filePath: string, line: number, column: number) => Promise<LspCompletionItem[]>;
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
  dapEvaluate?: (expression: string, frameId?: number) => Promise<{ result: string; type?: string }>;
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
  javaInstallOnlineJdk: (id: string) => Promise<{ success: boolean; javaHome?: string; message: string }>;
  /** 监听 JDK 在线下载与解压进度 */
  onJavaInstallProgress: (cb: (progress: JdkInstallProgress) => void) => () => void;
  /** 打开系统设置（如 macOS 本地网络隐私设置） */
  openSystemSettings?: (type?: string) => Promise<boolean>;
  /** 打开系统外部链接或本地网络服务 */
  openExternal?: (url: string) => Promise<boolean>;

  /** 代码库全局符号索引与自然语言语义搜索 */
  codebaseIndex: () => Promise<CodebaseIndexStatus>;
  codebaseSearch: (query: string, limit?: number) => Promise<CodebaseSymbolHit[]>;
  codebaseStatus: () => Promise<CodebaseIndexStatus>;

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
  | 'stopped'
  | 'continued'
  | 'output'
  | 'terminated'
  | 'exited'
  | 'breakpoint';

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
}

declare global {
  interface Window {
    ide: IpcApi;
  }
}


