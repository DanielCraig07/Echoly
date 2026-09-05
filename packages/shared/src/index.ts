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
  /** 自动更新源配置。未配置时禁用自动更新。 */
  updateFeed?: UpdateFeedConfig | null;
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
  updateFeed: null,
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
  /** Optional image attachments for multimodal models */
  images?: Array<{ dataUrl: string; mediaType: string }>;
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
  /** Data URL for image preview tabs (png/jpg/…); content stays empty. */
  previewUrl?: string;
  /** Large file (>2MB): content is intentionally left empty to avoid editor stalls. */
  isLargeFile?: boolean;
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: 'image' | 'file';
  mimeType?: string;
  size?: number;
  /** For image: data URL (data:image/...;base64,...). */
  dataUrl?: string;
  /** For text/code file: text content. */
  content?: string;
  path?: string;
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
}

export interface GitStatusResult {
  ok: boolean;
  detail?: string;
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

export interface GitDiffResult {
  ok: boolean;
  detail?: string;
  path: string;
  original: string;
  modified: string;
  staged: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitCommitEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  relativeDate?: string;
  message: string;
  parents?: string[];
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
}

export interface GitHistoryResult {
  ok: boolean;
  detail?: string;
  commits: GitCommitEntry[];
}

export interface GitBlameLineResult {
  ok: boolean;
  detail?: string;
  commit?: GitCommitEntry;
  line?: number;
}

export interface GitOpResult {
  ok: boolean;
  detail: string;
}

export interface RecentWorkspaceItem {
  path: string;
  name: string;
  lastOpenedAt: number;
  kind?: 'local' | 'ssh';
  sshServer?: string;
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
  openNewWindow: (targetPath?: string) => Promise<void>;
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
  downloadFile: (relPath: string) => Promise<string | null>;
  saveFileDialog: (defaultPath?: string) => Promise<string | null>;
  pickDirectory: () => Promise<string | null>;
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
  listSkills: () => Promise<SkillInfo[]>;
  openUserSkillsDir: () => Promise<string>;
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
  gitHistory: (maxCount?: number) => Promise<GitHistoryResult>;
  gitCommitDetails: (hash: string) => Promise<GitCommitDetailResult>;
  gitFileHistory: (path: string, maxCount?: number) => Promise<GitHistoryResult>;
  gitBlameLine: (path: string, line: number) => Promise<GitBlameLineResult>;
  gitShowCommitDiff: (hash: string, path: string) => Promise<GitDiffResult>;

  searchFiles: (query: string, max?: number) => Promise<SearchFileHit[]>;
  searchCode: (req: SearchCodeRequest) => Promise<SearchCodeHit[]>;
  sshConnect: (req: SshConnectRequest) => Promise<SshConnectResult>;
  sshDisconnect: () => Promise<void>;
  listSshProfiles: () => Promise<SshProfile[]>;
  listLocalSshConfig: () => Promise<SshProfile[]>;
  deleteSshProfile: (id: string) => Promise<void>;
  listRemoteDir: (
    remotePath?: string,
  ) => Promise<{ ok: boolean; entries?: RemoteDirEntry[]; currentPath?: string; detail?: string }>;
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
  onGitCloneLog: (cb: (line: string) => void) => () => void;
  onDownloadProgress: (
    cb: (progress: { percent: number; downloaded: number; total: number }) => void,
  ) => () => void;
  onExtensionWebviewRegistered: (cb: (data: { viewId: string }) => void) => () => void;
  extensionResolveWebview: (
    viewId: string,
  ) => Promise<{ success: boolean; html?: string; filePath?: string; error?: string }>;
  /** 检查更新（需已配置 updateFeed） */
  checkUpdate: () => Promise<{ ok: boolean; detail?: string }>;
  /** 获取更新状态 */
  getUpdateState: () => Promise<{ checked: boolean; feed: unknown }>;
}

declare global {
  interface Window {
    ide: IpcApi;
  }
}
