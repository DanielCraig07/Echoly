import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentMode,
  AppSettings,
  ChatAttachment,
  ChatMessage,
  ModelProfile,
  PendingDiff,
  PlanContext,
  PlanProposal,
  PlanTodo,
  ProviderConfig,
  QueuedUserMessage,
  ChatMessageMetrics,
  ToolDefinition,
} from '@deepseek-ide/shared';
import { syncPermissionBooleans, DEFAULT_LLM_MODEL } from '@deepseek-ide/shared';
import {
  UnifiedLlmClient,
  estimateTokensFromMessages,
  guardSettingsFromAppSettings,
  isLlmTimeoutError,
  isRepetitionLoopError,
} from '@deepseek-ide/llm';
import {
  executeTool,
  toolsForMode,
  type ToolContext,
  type ToolResult,
  type WorkspaceBackend,
  LocalFsBackend,
} from '@deepseek-ide/tools';
import {
  clampSummary,
  formatCompactionNotice,
  isCompactionNotice,
  splitForCompaction,
  summarizeCompaction,
} from './contextCompaction.js';

/**
 * 判断 baseUrl 是否指向本地或局域网私有 GPU 推理节点。
 * 本地私有节点显存及显存带宽有限，在大上下文下 Prefill 极易卡死或触发 PCIe 内存交换。
 * 系统会对其自动启用更加严格主动的 Token 预算和超时防护。
 */
export function isLocalOrPrivateNetworkUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local')
    ) {
      return true;
    }
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    const match172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (match172) {
      const secondOctet = parseInt(match172[1], 10);
      if (secondOctet >= 16 && secondOctet <= 31) return true;
    }
    return false;
  } catch {
    return /localhost|127\.0\.0\.1|192\.168\.|10\./i.test(url);
  }
}

export interface AgentRunOptions {
  prompt: string;
  workspaceRoot: string;
  settings: AppSettings;
  mode?: AgentMode;
  modelProfile?: ModelProfile;
  planContext?: PlanContext;
  skillsText?: string;
  rulesText?: string;
  backend?: WorkspaceBackend;
  openFiles?: Array<{ path: string; content: string }>;
  selection?: string;
  cursor?: { path: string; line: number; column: number };
  history?: ChatMessage[];
  attachments?: ChatAttachment[];
  applyImmediately?: boolean;
  /** 运行中实时读取权限，未提供则回退到 settings.permissionMode */
  getPermissionMode?: () => AppSettings['permissionMode'];
  onEvent: (event: AgentEvent) => void;
  requestConfirm: ToolContext['requestConfirm'];
  /** Resolves true to continue another maxAgentSteps chunk; false to stop. */
  requestContinue?: () => Promise<boolean>;
  signal?: AbortSignal;
  client?: any;
  /**
   * 编辑后自检用的诊断来源。宿主注入（主进程从 LSP 缓存 / 渲染层从 Monaco markers 取），
   * 未注入时 get_diagnostics 工具会向模型明确报「不可用」，而不是返回空的「一切正常」。
   */
  getDiagnostics?: ToolContext['getDiagnostics'];
  /** 代码库语义检索，宿主注入；未注入时 codebase_search 工具会明确报不可用。 */
  codebaseSearch?: ToolContext['codebaseSearch'];
  /**
   * 文件系统副作用的写前记录，宿主注入用于「撤销本轮 AI 改动」。
   * 未注入时工具照常工作，只是这一轮不可撤销。
   */
  onFileMutation?: ToolContext['onFileMutation'];
  /**
   * 运行中追加的消息。
   *
   * 主进程持有队列（用户随时可能提交），Agent 在每个「步骤边界」取空它 —— 也就是
   * 一次模型调用与它的工具执行全部结束之后。刻意不在工具执行中途插入：那样会让
   * 模型看到「调用了工具但还没看到结果，就先收到新要求」，它通常会放弃核对结果。
   */
  drainQueuedMessages?: () => QueuedUserMessage[];
  /** 取走队列时同步通知宿主，用于把界面上的「排队中」气泡标成已送达。 */
  onQueuedMessagesConsumed?: (ids: string[]) => void;
  /**
   * 宿主接入的 MCP 工具。
   *
   * 定义与执行分开传：定义是快照（本轮开始时的工具清单），执行是活的
   * （中途服务器可能掉线，那时应当如实报错而不是让模型一直调一个死工具）。
   * `readonlyNames` 决定 Ask / Plan 模式下哪些 MCP 工具可见且免确认。
   */
  mcp?: {
    definitions: ToolDefinition[];
    readonlyNames: Iterable<string>;
    call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
    /**
     * 暴露名 → 归属信息，仅用于生成 prompt 里的说明块。
     *
     * 为什么不从 `definitions[].description` 里解析服务器名：那是给人看的自由文本，
     * 解析它对每个 MCP 服务器都要写一套正则，而这张表在 Manager 里本来就是现成的。
     */
    meta?: Record<string, { serverName: string; readonly: boolean }>;
  };
}

const MAX_OPEN_FILE_CHARS = 12_000;
const MAX_LINES_PER_FILE = 200;
/** 光标附近上下文：前后各 N 行，控制在几 KB 内，避免整文件占满 context */
const CURSOR_LINES_BEFORE = 30;
const CURSOR_LINES_AFTER = 30;

function sliceFileContent(content: string, budget: number): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  const limited = lines.slice(0, MAX_LINES_PER_FILE).join('\n');
  if (limited.length <= budget) {
    return {
      text: limited,
      truncated: lines.length > MAX_LINES_PER_FILE || limited.length < content.length,
    };
  }
  return { text: limited.slice(0, budget), truncated: true };
}

/** 提取光标附近的文件片段（带行号），用于精确理解「当前正在看哪」 */
function formatCursorContext(cursor?: AgentRunOptions['cursor']): string {
  if (!cursor?.path || !cursor.line) return '';
  const target = cursor;
  return `\nCursor position: ${target.path}:${target.line}:${target.column}\n`;
}

function formatOpenFilesBlock(openFiles?: AgentRunOptions['openFiles']): string {
  if (!openFiles?.length) return 'Open files:\n(none)';

  const paths = openFiles
    .slice(0, 5)
    .map((f) => `- ${f.path} (${f.content.length} chars)`)
    .join('\n');

  let budget = MAX_OPEN_FILE_CHARS;
  const bodies: string[] = [];
  for (const f of openFiles.slice(0, 3)) {
    if (budget <= 0) break;
    const { text, truncated } = sliceFileContent(f.content, budget);
    budget -= text.length;
    bodies.push(`### ${f.path}${truncated ? ' (truncated)' : ''}\n\`\`\`\n${text}\n\`\`\``);
  }

  return `Open files (paths):\n${paths}\n\nOpen file contents (active first; truncated):\n${bodies.join('\n\n') || '(none)'}`;
}

export interface McpPromptTool {
  exposedName: string;
  description: string;
  serverName: string;
  readonly: boolean;
}

/**
 * 生成 MCP 工具的 prompt 说明块。
 *
 * 为什么不只依赖原生的 `tools` 参数：MCP 工具是**外部系统**的入口，模型需要知道
 * 两件 `tools` 参数表达不了的事 —— 哪些服务器是只读的（可以放心先试探），
 * 以及工具名里的 `<serverId>__` 前缀意味着什么（否则模型会把前缀当成名字的一部分，
 * 在参数里重复传服务器名）。
 *
 * 爆炸半径也要说清：这些工具连的是用户的生产系统，一个「顺手清理一下」的调用
 * 可能就是不可逆的外部副作用。因此这里明确要求先确认再动手。
 */
export function formatMcpToolsForPrompt(tools: McpPromptTool[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(
    (t) =>
      `- \`${t.exposedName}\`（${t.serverName}${t.readonly ? '，只读' : '，**可写**'}）：${t.description}`,
  );
  return [
    '以下工具来自外部 MCP 服务器（名字形如 `<服务器>__<工具>`，前缀已包含服务器信息，不要再作为参数传入）：',
    ...lines,
    '',
    '调用这些工具前请注意：',
    '- 它们操作的是**外部系统**，不是当前工作区，改动可能不可逆，也可能影响他人。',
    '- 标记为「可写」的工具在动手前必须先向用户说明你打算做什么、影响范围是什么。',
    '- 只有当任务确实需要访问对应外部系统时才调用；不要为了「多收集点信息」而试探性调用。',
    '- 调用失败时如实报告错误原文，不要假定外部系统已经成功而继续往下做。',
  ].join('\n');
}

function buildSystemPrompt(options: {
  workspaceRoot: string;
  mode: AgentMode;
  openFiles?: AgentRunOptions['openFiles'];
  selection?: string;
  cursor?: AgentRunOptions['cursor'];
  skillsText?: string;
  rulesText?: string;
  /** MCP 工具的说明块。工具清单本身走原生 tools 参数，这里只补模型需要知道的用法约束。 */
  mcpToolsText?: string;
  planContext?: PlanContext;
  backendKind?: string;
}): string {
  const {
    workspaceRoot,
    mode,
    openFiles,
    selection,
    cursor,
    skillsText,
    rulesText,
    mcpToolsText,
    planContext,
    backendKind,
  } = options;
  const selectionBlock = selection
    ? `\nCurrent selection:\n\`\`\`\n${selection.slice(0, 4000)}\n\`\`\`\n`
    : '';

  const sharedRules = `## Behavior
- Reply in the same language the user uses (default Chinese if unclear).
- Explore before editing: prefer search_code / search_symbols / glob_files / read_file / list_dir, then apply_patch or write_file.
- When you do not know which file declares something, search_symbols finds the declaration; codebase_search (if available) is for "where is this behavior implemented" questions rather than exact strings.
- After editing files, verify the change: call get_diagnostics and fix any ERROR it reports for the files you touched. If get_diagnostics is unavailable, run the project's build/typecheck/lint command via run_terminal instead. Do not claim a task is complete while errors you introduced are still outstanding.
- STRICTLY FORBIDDEN: Calling the same tool with identical arguments repeatedly. Once a file is read or a query is searched, analyze the information already in context.
- If a file's content was truncated, do NOT re-read the whole file with read_file; use read_file_lines with specific line offsets, or use search_code.
- Keep tool arguments valid JSON. On tool failure, read the error and retry or change strategy.
- For destructive or ambiguous actions, use ask_user (or wait for confirmation flows).
- Be concise in final answers; cite paths when referring to code. During long work, give short progress notes.
- Do not invent file contents you have not read.
- When you have sufficient information to answer the user's request, STOP calling tools immediately and output your final response.
- Never repeat yourself: once a step of reasoning has been stated, do not restate it. Keep the reasoning chain tight and move forward — do not loop back over conclusions you have already reached.`;

  const reasoningRules = `- Keep the reasoning channel concise. Do NOT restate or paraphrase earlier reasoning steps, and never repeat a sentence or paragraph you have already produced.
- When you reach a conclusion, stop thinking and act on it (call a tool or write the final answer). Do not re-verify the same conclusion over and over.`;

  const modeBlock =
    mode === 'ask'
      ? `You are in ASK mode — a read-only coding assistant in an IDE connected to an intranet Deepseek model.
Answer questions about the codebase. Use readonly tools only. Do NOT modify files or run write/mutating commands.
${sharedRules}
## Reasoning discipline
${reasoningRules}`
      : mode === 'plan'
        ? `You are in PLAN mode — explore the codebase with readonly tools, then produce an actionable implementation plan.
Do NOT modify files or run mutating commands.
${sharedRules}
## Reasoning discipline
${reasoningRules}
At the end of your final message you MUST include a fenced plan block exactly like:
\`\`\`plan
{"title":"...","summary":"...","todos":[{"id":"t1","content":"...","status":"pending"}]}
\`\`\`
Todos should be concrete, ordered steps.`
        : `You are a coding agent inside an IDE connected to an intranet Deepseek model.
You can explore and modify the workspace with tools.
## CRITICAL FILE MODIFICATION RULES (MANDATORY):
- ALL file creations and full rewrites MUST use write_file.
- ALL surgical edits MUST use apply_patch. If old_text is duplicate/not unique or difficult to match, or when appending lines, read the file with read_file and use write_file with the complete updated content.
- ALL file deletes/moves MUST use delete_path / move_path.
- STRICTLY FORBIDDEN: NEVER use run_terminal (or python/node scripts, echo >>, cat >, sed -i, awk, shell redirection) to create, edit, append to, or delete files in the workspace. Any file edits in run_terminal bypass IDE diff inspection and undo checkpoint recording, preventing the user from reviewing or reverting your changes!
- Use run_terminal ONLY for build, test, lint, package manager, or read-only inspection commands (e.g. ls, git status, pytest, npm test).
${sharedRules}
## Reasoning discipline
${reasoningRules}`;

  const planExecBlock =
    mode === 'agent' && planContext
      ? `\nYou are executing an approved plan. Follow todos in order; mark progress in your reasoning.
Plan title: ${planContext.title}
Summary: ${planContext.summary}
Todos:
${planContext.todos.map((t) => `- [${t.status}] ${t.id}: ${t.content}`).join('\n')}
`
      : '';

  const rulesBlock = rulesText
    ? `\n## Project Rules (.echolyrules)\nAlways adhere strictly to these project-level rules and conventions:\n${rulesText}\n`
    : '';

  const skillsBlock = skillsText ? `\n## Skills\n${skillsText}\n` : '';

  const mcpBlock = mcpToolsText ? `\n## MCP Tools\n${mcpToolsText}\n` : '';

  return `${modeBlock}
Workspace root: ${workspaceRoot} (${backendKind ?? 'local'})
${rulesBlock}${formatOpenFilesBlock(openFiles)}
${formatCursorContext(cursor)}${selectionBlock}${planExecBlock}${skillsBlock}${mcpBlock}`;
}

/**
 * Fallback: when the model does not support native tool_calls, parse
 * fenced code blocks of shape {"name":"...","arguments":{...}}
 *
 * 这段代码唯一的职责是「把一个工具调用从文本里救出来」，所以判定必须**偏松**：
 * 漏掉一个工具调用 = Agent 什么都没做就结束（用户看到的是一次空回合），
 * 而多解析出一个畸形条目 = 一次明确的「参数解析失败」错误，模型下一轮能自己改。
 *
 * 之前这里要求围栏后紧跟字面量「json tool」，于是
 * 「jsontool」「json  tool」「tool」、以及模型最自然的那种只带 json 标记的围栏
 * 全部落空。
 *
 * 唯一的例外是「不带 tool 标记」的围栏：那里必须同时具备 name 与 arguments
 * 才认（见下方 markedAsTool 分支），否则贴一段 package.json 就会被当成工具调用执行。
 */
export function parseXmlToolCalls(
  content: string,
): Array<{ id: string; name: string; args: string }> {
  const results: Array<{ id: string; name: string; args: string }> = [];
  // 围栏开口行的信息串整段捕获（`json tool` / `jsontool` / `tool` / `json` / 空），
  // 再在里面找 `tool` —— 用「允许任意空白」的写法无法覆盖 `jsontool` 这种粘连写法。
  const re = /```[ \t]*([^\n]*)\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const info = m[1] ?? '';
    const markedAsTool = /tool/i.test(info);
    const raw = (m[2] ?? '').trim();
    if (!raw) continue;
    const obj = parseToolCallObject(raw);
    if (!obj) continue;

    // name 必须是非空字符串：早先只做 `obj.name`，模型写出 `{"arguments":{...}}`
    // （漏了 name）时会造出一个 `name: undefined` 的调用，一路传到执行层才炸，
    // 报的还是「未知工具 undefined」这种看不懂的错。
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) continue;

    const hasArgs = obj.arguments !== undefined || obj.args !== undefined;
    // **没有 `tool` 标记的围栏必须同时具备 name 与 arguments/args 才算工具调用。**
    // 否则模型在回答里贴一段 `package.json`（第一个键就是 `"name"`）会被解析成
    // 一次对工具「my-app」的调用 —— 那比漏判严重得多：它会真的去执行。
    if (!markedAsTool && !hasArgs) continue;

    const args = obj.arguments ?? obj.args ?? {};
    results.push({
      id: `xml_${randomUUID()}`,
      name,
      args: typeof args === 'string' ? args : JSON.stringify(args),
    });
  }
  return results;
}

/**
 * 解析一个代码块的内容为工具调用对象。
 *
 * 三层兜底，因为这段文本是模型逐 token 生成的，任何一处都可能不完美：
 * 1. 直接 JSON.parse（绝大多数情况）
 * 2. 从第一个 `{` 到最后一个 `}` 再试一次（前后带了说明文字）
 * 3. 修掉常见畸形（尾随逗号、中文引号、未转义换行）后再试
 */
function parseToolCallObject(
  raw: string,
): { name?: unknown; arguments?: unknown; args?: unknown } | null {
  const attempts: string[] = [raw];

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));

  for (const candidate of [...attempts]) {
    attempts.push(
      candidate
        // 尾随逗号：`{"a":1,}` —— 模型写数组/对象时的高频笔误
        .replace(/,(\s*[}\]])/g, '$1')
        // 中文引号：只有在混进 JSON 结构里时才是错的，所以只替换成对出现的位置
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'"),
    );
  }

  for (const candidate of attempts) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return obj as { name?: unknown; arguments?: unknown; args?: unknown };
      }
    } catch {
      // 换下一种修法
    }
  }
  return null;
}

export function parsePlanProposal(content: string): PlanProposal | null {
  const re = /```plan\s*([\s\S]*?)```/i;
  const m = re.exec(content);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]) as {
      title?: string;
      summary?: string;
      todos?: Array<{ id?: string; content?: string; status?: string }>;
    };
    const todos: PlanTodo[] = (obj.todos ?? []).map((t, i) => ({
      id: t.id || `t${i + 1}`,
      content: t.content || '',
      status:
        t.status === 'completed' ||
        t.status === 'in_progress' ||
        t.status === 'cancelled' ||
        t.status === 'pending'
          ? t.status
          : 'pending',
    }));
    return {
      title: obj.title || 'Implementation plan',
      summary: obj.summary || content.replace(re, '').trim().slice(0, 2000),
      todos,
    };
  } catch {
    return null;
  }
}

/**
 * 追加消息在上下文里的包装。
 *
 * 必须显式标注「这是用户在你执行途中追加的」，否则模型会把它当成一次新的独立提问 ——
 * 于是丢掉手上没做完的活，或者反过来把已经做完的步骤再做一遍。
 * 同时明确要求**不要**重头开始，把「继续」这件事写进指令而不是指望模型自己推断。
 */
export function formatQueuedMessageBlock(content: string, attachmentBlocks: string): string {
  return [
    '[系统说明：以下是用户在本次任务执行过程中追加的消息。]',
    '请把它当作对当前任务的**补充要求**：先完成你手上正在进行的步骤，再据此调整后续做法。',
    '不要从头重做已经完成的步骤，也不要因此向用户重复确认原始需求。',
    '--- 用户追加的消息 ---',
    content,
    attachmentBlocks,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runAgent(
  options: AgentRunOptions,
): Promise<{ finalText: string; diffs: PendingDiff[]; metrics?: ChatMessageMetrics }> {
  const {
    prompt,
    workspaceRoot,
    settings,
    mode = 'agent',
    planContext,
    skillsText,
    openFiles,
    selection,
    history = [],
    attachments,
    onEvent,
    requestConfirm,
    requestContinue,
    signal,
  } = options;

  const backend = options.backend ?? new LocalFsBackend(workspaceRoot);

  // Get current model/provider config
  let providerConfig: ProviderConfig;
  if (options.modelProfile) {
    providerConfig = {
      provider: options.modelProfile.provider,
      baseUrl: options.modelProfile.baseUrl,
      apiKey: options.modelProfile.apiKey,
      model: options.modelProfile.model,
      enableThinking: options.modelProfile.enableThinking,
      thinkingTokens: options.modelProfile.thinkingTokens,
      reasoningEffort: options.modelProfile.reasoningEffort,
      reasoningEffortFine: options.modelProfile.reasoningEffortFine,
      thinkingTokenBudget: options.modelProfile.thinkingTokenBudget,
    };
  } else {
    const activeModel = settings.models?.find((m) => m.id === settings.activeModelId);
    if (activeModel) {
      providerConfig = {
        provider: activeModel.provider,
        baseUrl: activeModel.baseUrl,
        apiKey: activeModel.apiKey,
        model: activeModel.model,
        enableThinking: activeModel.enableThinking,
        thinkingTokens: activeModel.thinkingTokens,
        reasoningEffort: activeModel.reasoningEffort,
        reasoningEffortFine: activeModel.reasoningEffortFine,
        thinkingTokenBudget: activeModel.thinkingTokenBudget,
      };
    } else {
      const currentProvider = settings.currentProvider || 'deepseek';
      providerConfig = settings.providers?.[currentProvider] || {
        provider: currentProvider,
        baseUrl: settings.baseUrl || 'http://192.168.10.241:8002',
        apiKey: settings.apiKey || '',
        model: settings.model || DEFAULT_LLM_MODEL,
      };
    }
  }

  const client =
    options.client ?? new UnifiedLlmClient(providerConfig, guardSettingsFromAppSettings(settings));

  const getPermissionMode = (): AppSettings['permissionMode'] =>
    options.getPermissionMode?.() ?? settings.permissionMode ?? 'ask';
  const initialPermissionMode = getPermissionMode();
  const permissionBooleans = syncPermissionBooleans(initialPermissionMode);
  const windowTokens = settings.contextWindowTokens || 128000;

  const diffs: PendingDiff[] = [];
  const enqueueDiff: ToolContext['enqueueDiff'] = (diff) => {
    const pending: PendingDiff = {
      id: diff.id ?? randomUUID(),
      path: diff.path,
      original: diff.original,
      modified: diff.modified,
      description: diff.description,
    };
    diffs.push(pending);
    onEvent({ type: 'pending_diff', diff: pending });
    return pending;
  };

  const toolCtx: ToolContext = {
    workspaceRoot,
    backend,
    permissionMode: initialPermissionMode,
    getPermissionMode,
    autoApproveReadonlyTerminal: permissionBooleans.autoApproveReadonlyTerminal,
    requireConfirmForWrites: permissionBooleans.requireConfirmForWrites,
    requestConfirm: async (req) => {
      const mode = getPermissionMode();
      if (mode === 'allow_all_extreme') return true;
      // 允许所有：写/终端/删除自动放行；ask_user(other) 仍询问
      if (mode === 'allow_all' && req.kind !== 'other') return true;
      onEvent({ type: 'status', status: 'awaiting_confirm' });
      const ok = await requestConfirm(req);
      onEvent({ type: 'status', status: 'tool_running' });
      return ok;
    },
    enqueueDiff,
    applyImmediately: options.applyImmediately ?? true,
    getApplyImmediately: () => {
      if (options.applyImmediately !== undefined) return options.applyImmediately;
      return true;
    },
    getDiagnostics: options.getDiagnostics,
    codebaseSearch: options.codebaseSearch,
    onFileMutation: options.onFileMutation,
    // 把取消信号交给工具层：没有它，一条长跑命令按「停止」不会真的停。
    signal,
    mcp: options.mcp
      ? {
          toolNames: new Set(options.mcp.definitions.map((d) => d.function.name)),
          readonlyNames: new Set(options.mcp.readonlyNames),
          call: options.mcp.call,
        }
      : undefined,
  };

  const tools = toolsForMode(
    mode,
    options.mcp
      ? { definitions: options.mcp.definitions, readonlyNames: options.mcp.readonlyNames }
      : undefined,
  );

  type ImagePart = { dataUrl: string; mediaType: string };
  type DocumentPart = { dataUrl: string; mediaType: string; name?: string };

  /**
   * 把附件摊成两样东西：给模型看的文本块，以及走多模态通道的图片/文档。
   *
   * 抽成函数是因为它被用在两个地方：本轮的初始提问，以及运行中追加的消息。
   * 追加消息带附件是常见需求（「顺便看一下这张报错截图」），
   * 若只在初始提问里处理，追加上来的截图会被静默丢掉。
   */
  const collectAttachments = (
    list: ChatAttachment[] | undefined,
    images: ImagePart[],
    documents: DocumentPart[],
  ): string => {
    if (!list || list.length === 0) return '';
    const fileBlocks: string[] = [];
    for (const att of list) {
      const isBrowserRef = att.type === 'browser-element' || att.type === 'browser-page';
      const isImage =
        !isBrowserRef &&
        (att.type === 'image' ||
          att.mimeType?.startsWith('image/') ||
          /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name));
      const isPdf = att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.name);

      if (isImage && att.dataUrl) {
        fileBlocks.push(`\n\n--- 附件图片: ${att.name} ---`);
        const match = att.dataUrl.match(/^data:([^;]+);base64,/);
        const mediaType = match ? match[1] : att.mimeType || 'image/png';
        images.push({ dataUrl: att.dataUrl, mediaType });
      } else if (isPdf && att.dataUrl) {
        fileBlocks.push(`\n\n--- 附件文档(PDF): ${att.name} ---`);
        const match = att.dataUrl.match(/^data:([^;]+);base64,/);
        const mediaType = match ? match[1] : 'application/pdf';
        documents.push({ dataUrl: att.dataUrl, mediaType, name: att.name });
      } else if (att.type === 'browser-element' || att.browserElement) {
        const el = att.browserElement;
        if (el) {
          const styleLines = el.computedStyles
            ? Object.entries(el.computedStyles)
                .map(([k, v]) => `  ${k}: ${v}`)
                .join('\n')
            : '';
          const ancestorChain = el.ancestors?.length
            ? el.ancestors
                .map(
                  (a) =>
                    `${a.tagName}${a.id ? '#' + a.id : ''}${a.className ? '.' + a.className.split(/\s+/)[0] : ''}`,
                )
                .join(' > ')
            : '';
          const siblingLine = el.siblings
            ? `第 ${el.siblings.index + 1} / 共 ${el.siblings.total} 个子元素`
            : '';

          fileBlocks.push(`\n\n--- 引用的网页 DOM 元素 (${el.tagName}) ---
- 页面地址: ${el.url}
- 页面标题: ${el.pageTitle}
- 标签名: ${el.tagName}
- ID: ${el.id || '无'}
- 类名: ${el.className || '无'}
- CSS选择器路径: ${el.selectorPath || '无'}${el.selectorMatchCount && el.selectorMatchCount > 1 ? `（该选择器命中 ${el.selectorMatchCount} 个元素，定位时请结合上下文）` : ''}
- 祖先链: ${ancestorChain || '无'}
- 同级位置: ${siblingLine || '无'}
- 关键计算样式:
\`\`\`css
${styleLines || '（未采集）'}
\`\`\`
- 元素文本预览: ${el.textContent?.trim() || '无'}
- 元素 HTML 内容 (outerHTML):
\`\`\`html
${el.outerHtml || att.content || ''}
\`\`\``);
          // 元素渲染截图随附件图片通道一并交给多模态模型，便于直接判断视觉问题
          if (el.screenshotDataUrl) {
            const shotMatch = el.screenshotDataUrl.match(/^data:([^;]+);base64,/);
            images.push({
              dataUrl: el.screenshotDataUrl,
              mediaType: shotMatch ? shotMatch[1] : 'image/png',
            });
            fileBlocks.push(`\n（已附带该元素在页面中的渲染截图，请结合截图判断视觉效果）`);
          }
        } else {
          fileBlocks.push(
            `\n\n--- 引用的网页元素: ${att.name} ---\n\`\`\`html\n${att.content}\n\`\`\``,
          );
        }
      } else if (att.type === 'browser-page' || att.browserPage) {
        const page = att.browserPage;
        const errBlock =
          page?.errors && page.errors.length
            ? `\n- 页面控制台报错（最近 ${page.errors.length} 条）:\n\`\`\`text\n${page.errors.join('\n')}\n\`\`\``
            : '';
        fileBlocks.push(`\n\n--- 引用的浏览器页面 ---
- 页面地址: ${page?.url || ''}
- 页面标题: ${page?.title || att.name}${errBlock}

请结合该页面的实际实现（可在工作区中检索对应路由与组件源码）分析问题。`);
      } else if (att.content) {
        fileBlocks.push(`\n\n--- 附件文件: ${att.name} ---\n\`\`\`\n${att.content}\n\`\`\``);
      } else if (att.dataUrl) {
        fileBlocks.push(`\n\n--- 附件数据: ${att.name} ---`);
        documents.push({
          dataUrl: att.dataUrl,
          mediaType: att.mimeType || 'application/octet-stream',
          name: att.name,
        });
      }
    }
    return fileBlocks.join('');
  };

  const images: ImagePart[] = [];
  const documents: DocumentPart[] = [];
  const userMessage: ChatMessage = {
    role: 'user',
    content: `${prompt}${collectAttachments(attachments, images, documents)}`,
    images: images.length > 0 ? images : undefined,
    documents: documents.length > 0 ? documents : undefined,
  };

  let messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        workspaceRoot,
        mode,
        openFiles,
        selection,
        cursor: options.cursor,
        skillsText,
        rulesText: options.rulesText,
        mcpToolsText: options.mcp
          ? formatMcpToolsForPrompt(
              options.mcp.definitions.map((d) => {
                const info = options.mcp?.meta?.[d.function.name];
                return {
                  exposedName: d.function.name,
                  description: d.function.description,
                  serverName: info?.serverName ?? 'MCP',
                  readonly: info?.readonly ?? false,
                };
              }),
            )
          : undefined,
        planContext,
        backendKind: backend.kind,
      }),
    },
    ...history,
    userMessage,
  ];

  let finalText = '';
  const chunkSize = settings.maxAgentSteps ?? 50;
  let step = 0;
  let limit = chunkSize;

  // Loop Breaker: Track tool call signatures and intermediate reasoning to stop infinite loops
  const toolCallKeyHistory: string[] = [];
  let lastIntermediateContent = '';
  let consecutiveStuckSteps = 0;
  /**
   * 上一轮压缩留下的进展记录。
   *
   * 旧实现是 `summarizedOnce` 布尔量：整轮只准摘要一次，之后所有压缩都退回
   * 一行「早期细节已归档」。可上下文是**持续增长**的 —— 一次摘要撑不过上千步，
   * 再涨上去就只剩那行说明，前面积累的进展记录反而被下一次 Stage3 整段丢掉。
   * 改成允许再摘要，但把上一次的记录作为输入带上，让模型做**增量合并**。
   */
  let priorSummary: string | null = null;
  /** 上次摘要发生的步号，用于给重复摘要加冷却。 */
  let lastSummaryStep = -Infinity;

  const runStartTime = Date.now();
  let firstTokenGlobalTime: number | null = null;
  let totalCompletionTokens = 0;
  /**
   * 累计「模型真正在吐字」的时间，用作 tokens/s 的分母。
   *
   * 不能用 `now - runStartTime`：一整轮 Agent 里绝大部分耗时是工具执行
   * （读文件、跑终端、等用户确认、等 MCP 响应），把这些算进分母会让
   * 一个 60 tok/s 的模型在长任务里显示成 3 tok/s —— 用户看到的数字
   * 与实际推理速度无关，只会误导「模型是不是变慢了」的判断。
   */
  let totalGenerationMs = 0;
  let lastPromptTokens: number | undefined;
  let totalToolCallsCount = 0;
  let lastFinishReason: string | undefined;

  const buildCurrentMetrics = (): ChatMessageMetrics => {
    const now = Date.now();
    const durationMs = Math.max(0, now - runStartTime);
    const ttftMs =
      firstTokenGlobalTime !== null ? Math.max(0, firstTokenGlobalTime - runStartTime) : undefined;
    const tokensPerSecond =
      totalGenerationMs > 0 && totalCompletionTokens > 0
        ? Number(((totalCompletionTokens / totalGenerationMs) * 1000).toFixed(1))
        : undefined;
    const promptTokens = lastPromptTokens ?? estimateTokensFromMessages(messages);
    const totalTokens = promptTokens + totalCompletionTokens;

    return {
      model: providerConfig.model || DEFAULT_LLM_MODEL,
      durationMs,
      ttftMs,
      tokensPerSecond,
      promptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
      toolCallsCount: totalToolCallsCount,
      finishReason: lastFinishReason,
    };
  };

  const emitContextUsage = (usedTokens: number, source: 'api' | 'estimate') => {
    onEvent({
      type: 'context_usage',
      usedTokens,
      windowTokens,
      source,
    });
  };

  try {
    while (true) {
      while (step < limit) {
        if (signal?.aborted) {
          onEvent({ type: 'status', status: 'cancelled' });
          throw new Error('cancelled');
        }

        // 步骤边界：把用户在本轮运行途中追加的消息并进上下文。
        // 放在循环顶部（上一次的模型调用与工具执行都已结束）而不是中途，
        // 是为了让模型永远看到「工具调用 + 它的结果」成对出现。
        const queued = options.drainQueuedMessages?.() ?? [];
        if (queued.length > 0) {
          for (const q of queued) {
            // 每条追加消息用自己的图片/文档数组：把上一轮追加的截图挂到这一条上，
            // 会让模型以为用户又发了一遍。
            const qImages: ImagePart[] = [];
            const qDocuments: DocumentPart[] = [];
            const blocks = collectAttachments(q.attachments, qImages, qDocuments);
            messages.push({
              role: 'user',
              content: formatQueuedMessageBlock(q.content, blocks),
              images: qImages.length > 0 ? qImages : undefined,
              documents: qDocuments.length > 0 ? qDocuments : undefined,
            });
          }
          options.onQueuedMessagesConsumed?.(queued.map((q) => q.id));
        }

        // Context Compaction：先免费截断，仍超预算才请模型写一份进展摘要。
        // 详细的分层理由见 contextCompaction.ts。
        let estimated = estimateTokensFromMessages(messages);
        const isLocalNode = isLocalOrPrivateNetworkUrl(providerConfig.baseUrl);
        const defaultLocalBudget = 22000;
        const defaultCloudBudget = 60000;
        const maxPromptBudget = isLocalNode
          ? Math.min(
              windowTokens ? Math.floor(windowTokens * 0.5) : defaultLocalBudget,
              defaultLocalBudget,
            )
          : Math.min(
              windowTokens ? Math.floor(windowTokens * 0.75) : defaultCloudBudget,
              defaultCloudBudget,
            );

        if (estimated > maxPromptBudget && messages.length > 8) {
          const tailReserve = isLocalNode ? 4 : 8;
          /**
           * Stage 1 与 Stage 2 都靠**改写正文**生效，而 `messages` 里的历史条目
           * 与调用方共享同一个对象引用（`messages` 是用 `...history` 拼出来的，
           * 上一轮的会话记录拿的就是这批对象）。就地 `m.content = ...` 等于把
           * 用户的历史消息也永久改短了：切回那个会话时，当初的完整回答只剩下
           * 前 150 个字符 —— 而且没有任何报错，看起来就像消息本来就那么短。
           *
           * 所以只对「会被压缩的那一段」做浅拷贝，后面两步都改副本。
           */
          const working = messages.slice();
          for (let i = 1; i < messages.length - tailReserve; i++) {
            working[i] = { ...working[i] };
          }

          // Stage 1: Compress older tool outputs
          for (let i = 1; i < messages.length - tailReserve; i++) {
            const m = working[i];
            if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 300) {
              m.content = `${m.content.slice(0, 200)}\n...[早期步骤输出已压缩]`;
            }
          }
          estimated = estimateTokensFromMessages(working);

          // Stage 2: If still over budget, prune verbose reasoning and thinking blocks from early turns
          if (estimated > maxPromptBudget) {
            for (let i = 1; i < messages.length - tailReserve; i++) {
              const m = working[i];
              if (
                m.role === 'assistant' &&
                typeof m.content === 'string' &&
                m.content.length > 200
              ) {
                m.content = `${m.content.slice(0, 150)}...[前序思考已简述]`;
              }
              if (m.thinking?.length) {
                m.thinking = undefined;
              }
            }
            estimated = estimateTokensFromMessages(working);
          }

          // 到这里 Stage 1/2 的成果必须落回 `messages`：Stage 3 可能因为条数不够
          // 而不触发，只改副本不改引用的话，这一轮等于什么都没压缩。
          messages = working;

          // Stage 3: 滑动窗口。与旧实现的区别在于中间段落不再直接丢弃，
          // 而是先尝试交给模型归档成一份进展记录，丢了什么由模型自己判断。
          const stage3Threshold = isLocalNode ? 10 : 18;
          const stage3RecentCount = isLocalNode ? 8 : 14;
          if (estimated > maxPromptBudget && working.length > stage3Threshold) {
            // 保留 [0]（system）为前缀；userMessage 在下面显式拼回，所以它不参与 tail，
            // 否则同一份（可能带上附件正文的）用户消息会被塞两次。
            const split = splitForCompaction(working, 1, stage3RecentCount);
            // 尾部可能以 tool 结果开头，其发起方被切在 middle 里 ——
            // 孤立的 tool 结果会让多数网关直接 400，这里整段丢掉这几条。
            let tail = split.keepTail.filter((m) => m !== userMessage);
            let orphanCount = 0;
            while (tail.length > 0 && tail[0].role === 'tool') {
              tail = tail.slice(1);
              orphanCount++;
            }

            let notice: string | null = null;
            // 冷却：摘要是一次真实的模型调用，不能每步都做。两次摘要之间至少隔
            // 这么多步，否则上下文一旦越过预算线就会连续触发，压缩开销盖过它省下的 token。
            const SUMMARY_COOLDOWN_STEPS = 12;
            if (step - lastSummaryStep >= SUMMARY_COOLDOWN_STEPS) {
              lastSummaryStep = step;
              onEvent({ type: 'status', status: 'thinking' });
              const summary = await summarizeCompaction(client, {
                // 上一次的压缩说明本身不要喂进摘要输入：它包含的内容已经由
                // priorSummary 单独带进去了，重复一遍只会挤占片段预算。
                middle: split.middle.filter((m) => !isCompactionNotice(m)),
                originalPrompt: prompt,
                droppedFromTruncation: orphanCount,
                priorSummary,
                signal,
              });
              if (summary) {
                // 保留未截断的版本给下一次合并用，喂给模型的用截断后的
                priorSummary = summary;
                notice = formatCompactionNotice(clampSummary(summary), prompt);
              }
            }
            if (!notice) {
              // 摘要不可用（失败 / 处于冷却期 / 没有可压缩内容）：退回原来的说明。
              // 有历史记录时把它带上 —— 直接丢掉等于把前面积累的进展抹掉。
              notice = [
                `[系统说明：当前执行步数较多，早期的中间调用细节已归档压缩。]`,
                `【当前任务的原始诉求】:`,
                `"""`,
                prompt.trim(),
                `"""`,
                ...(priorSummary
                  ? [
                      `【此前已归档的进展记录（仍然有效，请勿重复已完成的步骤）】:`,
                      clampSummary(priorSummary),
                    ]
                  : []),
                `请直接基于上述原始诉求、当前工作区最新状态及最近的工具调用结果，继续完成任务并直接向用户给出最终结论。`,
                `【特别注意】：若当前改动已完整且测试已通过，请直接总结任务成果并回复用户，切勿因中间历史被压缩而向用户询问重复确认原始诉求。`,
              ].join('\n');
            }

            messages = [
              working[0],
              userMessage,
              {
                role: 'system',
                content: notice,
              },
              ...tail,
            ];
          }
        }

        onEvent({ type: 'step_progress', step: step + 1, maxSteps: limit });
        onEvent({ type: 'status', status: 'thinking' });
        emitContextUsage(estimateTokensFromMessages(messages), 'estimate');

        // If the model is repeatedly stuck in a tool loop, remove tools to force text conclusion
        const effectiveTools = consecutiveStuckSteps >= 2 ? undefined : tools;

        let assistant: ChatMessage;
        /** 本轮服务端停止原因，用于区分正常结束与被 max_tokens 截断。 */
        let finishReason: string | undefined;
        let callAttempts = 0;
        const maxTimeoutRetries = 1;
        let loopAttempts = 0;
        const maxLoopRetries = 1;
        let samplingOverride: { frequencyPenalty?: number; presencePenalty?: number } | undefined;

        while (true) {
          try {
            let callFirstTokenTime: number | null = null;
            /** 本次调用的最后一个 token 到达时刻，用于算这次调用真正吐字花了多久。 */
            let callLastTokenTime: number | null = null;
            const callStartTime = Date.now();
            const result = await client.chatStreamCollect(
              {
                messages,
                tools: effectiveTools,
                signal,
                frequencyPenalty: samplingOverride?.frequencyPenalty,
                presencePenalty: samplingOverride?.presencePenalty,
              },
              (token: string) => {
                const now = Date.now();
                if (callFirstTokenTime === null) callFirstTokenTime = now;
                if (firstTokenGlobalTime === null) firstTokenGlobalTime = now;
                callLastTokenTime = now;
                onEvent({ type: 'token', text: token });
              },
              (thinking: string) => {
                const now = Date.now();
                if (callFirstTokenTime === null) callFirstTokenTime = now;
                if (firstTokenGlobalTime === null) firstTokenGlobalTime = now;
                callLastTokenTime = now;
                onEvent({ type: 'thinking_token', text: thinking });
              },
            );
            assistant = result.message;
            finishReason = result.finishReason;
            lastFinishReason = finishReason;

            // 计入吐字时长：有 token 用「首 token → 末 token」，一个 token 都没吐
            // （例如直接返回 tool_calls）时不计——那种调用本来就没有生成速度可言。
            if (callFirstTokenTime !== null && callLastTokenTime !== null) {
              totalGenerationMs += Math.max(0, callLastTokenTime - callFirstTokenTime);
            } else if (
              result.usage?.completionTokens != null &&
              result.usage.completionTokens > 0
            ) {
              // 服务端没有走流式回调（部分后端在非流式回退时会一次性返回整段），
              // 退而求其次用整次调用的墙钟时间。
              totalGenerationMs += Math.max(0, Date.now() - callStartTime);
            }

            if (result.usage?.promptTokens != null) {
              lastPromptTokens = result.usage.promptTokens;
            }
            if (result.usage?.completionTokens != null) {
              totalCompletionTokens += result.usage.completionTokens;
            } else {
              const generatedText = (assistant.content || '') + (assistant.reasoning_content || '');
              totalCompletionTokens += Math.max(1, Math.round(generatedText.length / 3));
            }

            if (result.usage?.totalTokens != null) {
              emitContextUsage(result.usage.totalTokens, 'api');
            } else if (result.usage?.promptTokens != null) {
              emitContextUsage(
                result.usage.promptTokens + (result.usage.completionTokens ?? 0),
                'api',
              );
            }
            break;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (
              signal?.aborted ||
              (err instanceof Error && err.name === 'AbortError') ||
              /aborted|abort|cancelled/i.test(msg)
            ) {
              throw new Error('cancelled');
            }

            // 复读退化熔断：模型陷入「重复同一句话」的死循环，已由流式层掐断。
            if (isRepetitionLoopError(err)) {
              const partial = (err as { partialMessage?: ChatMessage }).partialMessage;
              const recovered = (partial?.content ?? '').trim();

              // 思考阶段陷入死循环且未产出任何有效内容时，自动优化提示词并破环重试
              if (!recovered && loopAttempts < maxLoopRetries) {
                loopAttempts++;
                callAttempts++;
                onEvent({ type: 'status', status: 'thinking' });

                // 清洗上下文：移除历史消息中残留的所有 thinking 残留（消除循环吸引子）
                for (const m of messages) {
                  if (m.thinking) m.thinking = undefined;
                  if (m.reasoning_content) m.reasoning_content = undefined;
                  if (
                    m.role === 'tool' &&
                    typeof m.content === 'string' &&
                    m.content.length > 200
                  ) {
                    m.content = `${m.content.slice(0, 150)}...[因思考防环已精简]`;
                  }
                }

                const antiLoopDirective = [
                  `[系统自愈干预：上一轮推理在思考阶段陷入循环反思（Repetition Loop），未能产出有效行动。]`,
                  `【强制破环执行规则】:`,
                  `1. 严格禁止展开长篇思考与无限自我反思推演；`,
                  `2. 保持思考简明扼要，直奔核心行动；`,
                  `3. 如需调用工具，直接给出具体的工具调用（参数必须完整有效）；`,
                  `4. 如需回答用户，直接输出精炼、明确、可执行的最终结论；`,
                  `5. 绝不要重复上一轮陷入停滞的反复怀疑或自指推演。`,
                  `【当前任务的原始诉求】:`,
                  `"""`,
                  prompt.trim(),
                  `"""`,
                  `请直接基于当前工作区状态与上述诉求继续完成任务。`,
                ].join('\n');

                const recent = messages.slice(-4);
                let firstClean = 0;
                while (firstClean < recent.length && recent[firstClean].role === 'tool') {
                  firstClean++;
                }
                const cleanRecent = recent.slice(firstClean);

                messages = [
                  messages[0],
                  userMessage,
                  {
                    role: 'system',
                    content: antiLoopDirective,
                  },
                  ...cleanRecent,
                ];

                // 提升采样惩罚以打破确定性复读循环
                samplingOverride = {
                  frequencyPenalty: 0.5,
                  presencePenalty: 0.5,
                };

                emitContextUsage(estimateTokensFromMessages(messages), 'estimate');
                continue;
              }

              // 超过重试次数或已有大量可用回复正文时，收尾熔断
              const loopNotice =
                '[系统提示] 检测到模型输出陷入周期性重复，已自动熔断该次生成以避免无限复读。';
              finalText = recovered
                ? `${recovered}\n\n> ${loopNotice}`
                : `模型在思考阶段陷入重复循环，未能产出有效内容。请重试，或换用更简明的提问方式。\n\n> ${loopNotice}`;
              const metrics = buildCurrentMetrics();
              onEvent({ type: 'assistant_message', content: finalText });
              onEvent({ type: 'status', status: 'done' });
              // 带显式标志位而不是让渲染层去比对那句话：渲染层要拿它决定「这条熔断消息
              // 不回灌上下文」（否则会诱导模型接着复读），比对文案的话改一次措辞就失效。
              onEvent({ type: 'done', finalText, metrics, circuitBroken: true });
              return { finalText, diffs, metrics };
            }

            // Watchdog Timeout Protection & Auto-healing Retry:
            // If local model server stalled (>60s TTFT), drastically prune messages and retry automatically
            if (isLlmTimeoutError(err) && callAttempts < maxTimeoutRetries) {
              callAttempts++;
              onEvent({ type: 'status', status: 'thinking' });
              if (messages.length > 3) {
                const recent = messages.slice(-4);
                let firstClean = 0;
                while (firstClean < recent.length && recent[firstClean].role === 'tool') {
                  firstClean++;
                }
                const cleanRecent = recent.slice(firstClean);
                for (const m of cleanRecent) {
                  if (
                    m.role === 'tool' &&
                    typeof m.content === 'string' &&
                    m.content.length > 200
                  ) {
                    m.content = `${m.content.slice(0, 150)}...[因节点显存超时已紧急精简]`;
                  }
                  if (m.thinking) m.thinking = undefined;
                }
                const emergencyNotice = [
                  `[系统自愈提示：上一轮推理响应超时（>60s），已执行紧急深度上下文压缩。]`,
                  `【当前任务的原始诉求】:`,
                  `"""`,
                  prompt.trim(),
                  `"""`,
                  `请直接基于上述原始诉求与当前改动结果给出最终结论。若任务已完成，请直接输出最终总结，严禁因压缩而反问用户原始诉求。`,
                ].join('\n');

                messages = [
                  messages[0],
                  userMessage,
                  {
                    role: 'system',
                    content: emergencyNotice,
                  },
                  ...cleanRecent,
                ];
                emitContextUsage(estimateTokensFromMessages(messages), 'estimate');
              }
              continue;
            }

            // If native tool calling failed or not supported, fallback to prompt-based execution
            if (
              tools.length > 0 &&
              err instanceof Error &&
              /tools|function|unsupported|not supported|bad request/i.test(err.message)
            ) {
              const result = await client.chatStreamCollect(
                {
                  messages,
                  signal,
                },
                (token: string) => onEvent({ type: 'token', text: token }),
                (thinking: string) => onEvent({ type: 'thinking_token', text: thinking }),
              );
              assistant = result.message;
              finishReason = result.finishReason;
              if (result.usage?.totalTokens != null) {
                emitContextUsage(result.usage.totalTokens, 'api');
              }
              break;
            } else {
              throw err;
            }
          }
        }

        messages.push(assistant);
        step += 1;

        let toolCalls =
          assistant.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args:
              tc.function.arguments && tc.function.arguments.trim() ? tc.function.arguments : '{}',
          })) ?? [];

        if (!toolCalls.length && assistant.content && consecutiveStuckSteps < 2) {
          toolCalls = parseXmlToolCalls(assistant.content);
        }

        if (!toolCalls.length) {
          // Normalize once so the intermediate `assistant_message` bubble and the
          // `done` event carry identical text — otherwise the renderer can't match
          // them up and ends up rendering the final answer twice.
          finalText = (assistant.content ?? '')
            .split('\n')
            .filter((line) => !/^-{3,}\s*$/.test(line.trim()))
            .join('\n')
            .trim();
          if (!finalText && step > 1) {
            finalText = `已完成计划中的修改与执行（共执行了 ${step - 1} 步工具操作）。详细执行过程可展开上方「Worked for」时间线查看。`;
          }
          // 撞到 max_tokens 被截断：内容本身可用，但要如实告诉用户它不完整，
          // 否则「回答说到一半突然停住」看起来像是模型出错了。
          if (finishReason === 'length' && finalText) {
            finalText +=
              '\n\n> [系统提示] 本次回答达到输出长度上限被截断，内容可能不完整。可要求继续，或缩小问题范围后重试。';
          }
          onEvent({ type: 'assistant_message', content: finalText });
          if (mode === 'plan') {
            const plan =
              parsePlanProposal(finalText) ??
              ({
                title: 'Implementation plan',
                summary: finalText.slice(0, 4000),
                todos: [],
              } satisfies PlanProposal);
            onEvent({ type: 'plan_proposal', plan });
          }
          onEvent({ type: 'status', status: 'done' });
          const metrics = buildCurrentMetrics();
          onEvent({ type: 'done', finalText, metrics });
          return { finalText, diffs, metrics };
        }

        // Persist intermediate reasoning before tools so UI does not lose streaming text.
        // Strip bare --- separator lines which the model uses in reasoning but render as <hr> in Markdown.
        const thoughtToDisplay = (
          assistant.reasoning_content ||
          assistant.thinking?.map((t) => t.thinking).join('\n') ||
          '' ||
          assistant.content ||
          ''
        ).trim();
        if (thoughtToDisplay) {
          const displayContent = thoughtToDisplay
            .split('\n')
            .filter((line) => !/^-{3,}\s*$/.test(line.trim()))
            .join('\n')
            .trim();
          if (displayContent) {
            // Deduplicate consecutive identical intermediate thoughts to prevent UI message flood
            if (displayContent !== lastIntermediateContent) {
              onEvent({ type: 'assistant_message', content: displayContent });
              lastIntermediateContent = displayContent;
            }
          }
        }

        totalToolCallsCount += toolCalls.length;

        for (const call of toolCalls) {
          if (signal?.aborted) throw new Error('cancelled');
          if (mode !== 'agent') {
            const allowed = new Set(tools.map((t) => t.function.name));
            if (!allowed.has(call.name)) {
              onEvent({
                type: 'tool_result',
                id: call.id,
                name: call.name,
                result: `Tool ${call.name} is not available in ${mode} mode`,
                isError: true,
              });
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: `Tool ${call.name} is not available in ${mode} mode`,
              });
              continue;
            }
          }
          let parsedArgs: unknown = call.args;
          try {
            parsedArgs = JSON.parse(call.args || '{}');
          } catch {
            parsedArgs = call.args;
          }

          // Loop Breaker: calculate normalized signature of this call
          let normalizedArgKey =
            typeof call.args === 'string' ? call.args.trim() : JSON.stringify(call.args ?? {});
          try {
            if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
              normalizedArgKey = JSON.stringify(
                Object.keys(parsedArgs as Record<string, unknown>)
                  .sort()
                  .reduce(
                    (acc, k) => {
                      acc[k] = (parsedArgs as Record<string, unknown>)[k];
                      return acc;
                    },
                    {} as Record<string, unknown>,
                  ),
              );
            }
          } catch {
            // fallback
          }
          const callSignature = `${call.name}::${normalizedArgKey}`;
          const recentCalls = toolCallKeyHistory.slice(-6);
          const repeatCount = recentCalls.filter((sig) => sig === callSignature).length;
          toolCallKeyHistory.push(callSignature);

          // Circuit Breaker Activated!
          if (repeatCount >= 2) {
            consecutiveStuckSteps++;
            const circuitBreakerMsg =
              `[系统熔断警告]: 检测到你已连续多次使用完全相同的参数调用工具 "${call.name}"。\n` +
              `为防止死循环，该工具调用已被系统直接拦截并终止执行。\n` +
              `【严禁再次重复调用该工具及相同参数】！\n` +
              `请立刻根据上下文中已获取的信息完成综合分析，直接向用户输出最终答复；如果必须继续，请更换其它工具或指定新的参数。`;

            onEvent({ type: 'tool_start', id: call.id, name: call.name, args: parsedArgs });
            onEvent({
              type: 'tool_result',
              id: call.id,
              name: call.name,
              result: circuitBreakerMsg,
              isError: true,
            });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: circuitBreakerMsg,
            });
            continue;
          }

          if (repeatCount === 0) {
            consecutiveStuckSteps = 0;
          }

          onEvent({ type: 'status', status: 'tool_running' });
          onEvent({ type: 'tool_start', id: call.id, name: call.name, args: parsedArgs });
          const result = await executeTool(call.name, call.args, {
            ...toolCtx,
            onTerminalOutput: (chunk) => {
              onEvent({ type: 'tool_output', id: call.id, chunk });
            },
          });
          // Limit tool result length to prevent context overflow
          const MAX_TOOL_RESULT_LENGTH = 8000;
          let toolResultContent = result.content;
          if (toolResultContent.length > MAX_TOOL_RESULT_LENGTH) {
            toolResultContent =
              toolResultContent.slice(0, MAX_TOOL_RESULT_LENGTH) +
              `\n\n[输出已截断，原长度: ${toolResultContent.length} 字符。若需读取后续内容，请使用 read_file_lines 指定起始行号 offset，切勿重新使用 read_file 重复读取整文件]`;
          }

          // If this is the 2nd identical call in recent history, append a gentle warning to nip the loop in the bud
          if (repeatCount === 1) {
            toolResultContent += `\n\n[系统提示]: 你刚刚已读取过完全相同的内容。严禁再次以相同参数调用 ${call.name} 工具。请直接根据已获得的数据进行思考与总结。`;
          }

          onEvent({
            type: 'tool_result',
            id: call.id,
            name: call.name,
            result: toolResultContent,
            isError: result.isError,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResultContent,
          });
        }
      }

      onEvent({
        type: 'max_steps_reached',
        completedSteps: step,
        chunkSize,
      });
      onEvent({ type: 'status', status: 'awaiting_continue' });

      const shouldContinue = requestContinue ? await requestContinue() : false;
      if (!shouldContinue || signal?.aborted) {
        finalText = 'Reached max agent steps without a final answer.';
        onEvent({ type: 'error', message: finalText });
        onEvent({ type: 'status', status: 'error' });
        return { finalText, diffs };
      }

      limit += chunkSize;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted =
      signal?.aborted ||
      (err instanceof Error && err.name === 'AbortError') ||
      message === 'cancelled' ||
      /aborted|abort/i.test(message);
    if (aborted) {
      onEvent({ type: 'status', status: 'cancelled' });
      const metrics = buildCurrentMetrics();
      onEvent({ type: 'done', finalText: '(cancelled)', metrics });
      return { finalText: '(cancelled)', diffs, metrics };
    }
    onEvent({ type: 'error', message });
    onEvent({ type: 'status', status: 'error' });
    throw err;
  }
}

/**
 * MCP 客户端。与 `@deepseek-ide/tools` 的关系是：那里定义工具与权限门控，
 * 这里负责说 MCP 协议并把子进程管起来。放在 agent 包是因为它依赖的东西
 * （spawn、JSON-RPC）与 Agent 循环同属「执行侧」，而 tools 包要保持可在
 * 无子进程环境下被纯逻辑单测。
 */
export { McpManager, MAX_TOOLS_PER_SERVER } from './mcp/manager.js';
export type { McpServerConfig, McpToolInfo, McpServerStatus } from './mcp/manager.js';
export { StdioMcpTransport, McpTransportClosedError } from './mcp/transport.js';
export {
  LineJsonRpcDecoder,
  flattenMcpContent,
  mcpToolName,
  MCP_PROTOCOL_VERSION,
} from './mcp/protocol.js';
