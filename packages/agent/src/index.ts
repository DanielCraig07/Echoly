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
} from '@deepseek-ide/shared';
import { syncPermissionBooleans } from '@deepseek-ide/shared';
import { UnifiedLlmClient, estimateTokensFromMessages, isLlmTimeoutError } from '@deepseek-ide/llm';
import {
  executeTool,
  toolsForMode,
  type ToolContext,
  type WorkspaceBackend,
  LocalFsBackend,
} from '@deepseek-ide/tools';

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

function buildSystemPrompt(options: {
  workspaceRoot: string;
  mode: AgentMode;
  openFiles?: AgentRunOptions['openFiles'];
  selection?: string;
  cursor?: AgentRunOptions['cursor'];
  skillsText?: string;
  rulesText?: string;
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
    planContext,
    backendKind,
  } = options;
  const selectionBlock = selection
    ? `\nCurrent selection:\n\`\`\`\n${selection.slice(0, 4000)}\n\`\`\`\n`
    : '';

  const sharedRules = `## Behavior
- Reply in the same language the user uses (default Chinese if unclear).
- Explore before editing: prefer search_code / glob_files / read_file / list_dir, then apply_patch or write_file.
- STRICTLY FORBIDDEN: Calling the same tool with identical arguments repeatedly. Once a file is read or a query is searched, analyze the information already in context.
- If a file's content was truncated, do NOT re-read the whole file with read_file; use read_file_lines with specific line offsets, or use search_code.
- Keep tool arguments valid JSON. On tool failure, read the error and retry or change strategy.
- For destructive or ambiguous actions, use ask_user (or wait for confirmation flows).
- Be concise in final answers; cite paths when referring to code. During long work, give short progress notes.
- Do not invent file contents you have not read.
- When you have sufficient information to answer the user's request, STOP calling tools immediately and output your final response.`;

  const modeBlock =
    mode === 'ask'
      ? `You are in ASK mode — a read-only coding assistant in an IDE connected to an intranet Deepseek model.
Answer questions about the codebase. Use readonly tools only. Do NOT modify files or run write/mutating commands.
${sharedRules}`
      : mode === 'plan'
        ? `You are in PLAN mode — explore the codebase with readonly tools, then produce an actionable implementation plan.
Do NOT modify files or run mutating commands.
${sharedRules}
At the end of your final message you MUST include a fenced plan block exactly like:
\`\`\`plan
{"title":"...","summary":"...","todos":[{"id":"t1","content":"...","status":"pending"}]}
\`\`\`
Todos should be concrete, ordered steps.`
        : `You are a coding agent inside an IDE connected to an intranet Deepseek model.
You can explore and modify the workspace with tools.
Use apply_patch for surgical edits; write_file for new files or full rewrites.
${sharedRules}`;

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

  return `${modeBlock}
Workspace root: ${workspaceRoot} (${backendKind ?? 'local'})
${rulesBlock}${formatOpenFilesBlock(openFiles)}
${formatCursorContext(cursor)}${selectionBlock}${planExecBlock}${skillsBlock}`;
}

/**
 * Fallback: when the model does not support native tool_calls, parse
 * ```json tool blocks of shape {"name":"...","arguments":{...}}
 */
export function parseXmlToolCalls(
  content: string,
): Array<{ id: string; name: string; args: string }> {
  const results: Array<{ id: string; name: string; args: string }> = [];
  const re = /```json\s*tool\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    try {
      const obj = JSON.parse(m[1]) as { name: string; arguments?: unknown; args?: unknown };
      const args = obj.arguments ?? obj.args ?? {};
      results.push({
        id: `xml_${randomUUID()}`,
        name: obj.name,
        args: typeof args === 'string' ? args : JSON.stringify(args),
      });
    } catch {
      // ignore
    }
  }
  return results;
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

export async function runAgent(
  options: AgentRunOptions,
): Promise<{ finalText: string; diffs: PendingDiff[] }> {
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
      };
    } else {
      const currentProvider = settings.currentProvider || 'deepseek';
      providerConfig = settings.providers?.[currentProvider] || {
        provider: currentProvider,
        baseUrl: settings.baseUrl || 'http://192.168.10.241:8002',
        apiKey: settings.apiKey || '',
        model: settings.model || 'deepseek-v4-flash',
      };
    }
  }

  const client = options.client ?? new UnifiedLlmClient(providerConfig);

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
  };

  const tools = toolsForMode(mode);

  let userPrompt = prompt;
  const images: Array<{ dataUrl: string; mediaType: string }> = [];
  const documents: Array<{ dataUrl: string; mediaType: string; name?: string }> = [];

  if (attachments && attachments.length > 0) {
    const fileBlocks: string[] = [];
    for (const att of attachments) {
      const isImage =
        att.type === 'image' ||
        att.mimeType?.startsWith('image/') ||
        /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(att.name);
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
    if (fileBlocks.length > 0) {
      userPrompt = `${prompt}${fileBlocks.join('')}`;
    }
  }

  const userMessage: ChatMessage = {
    role: 'user',
    content: userPrompt,
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

        // Context Compaction: If tool history gets too large, compress older tool results to prevent model server stalling
        let estimated = estimateTokensFromMessages(messages);
        const isLocalNode = isLocalOrPrivateNetworkUrl(providerConfig.baseUrl);
        const defaultLocalBudget = 22000;
        const defaultCloudBudget = 60000;
        const maxPromptBudget = isLocalNode
          ? Math.min(windowTokens ? Math.floor(windowTokens * 0.5) : defaultLocalBudget, defaultLocalBudget)
          : Math.min(windowTokens ? Math.floor(windowTokens * 0.75) : defaultCloudBudget, defaultCloudBudget);

        if (estimated > maxPromptBudget && messages.length > 8) {
          // Stage 1: Compress older tool outputs
          for (let i = 1; i < messages.length - (isLocalNode ? 4 : 8); i++) {
            const m = messages[i];
            if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 300) {
              m.content = `${m.content.slice(0, 200)}\n...[早期步骤输出已压缩]`;
            }
          }
          estimated = estimateTokensFromMessages(messages);

          // Stage 2: If still over budget, prune verbose reasoning and thinking blocks from early turns
          if (estimated > maxPromptBudget) {
            for (let i = 1; i < messages.length - (isLocalNode ? 4 : 8); i++) {
              const m = messages[i];
              if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 200) {
                m.content = `${m.content.slice(0, 150)}...[前序思考已简述]`;
              }
              if (m.thinking?.length) {
                m.thinking = undefined;
              }
            }
            estimated = estimateTokensFromMessages(messages);
          }

          // Stage 3: If still over budget, slide the middle window keeping system (0), initial user turn (1), and recent messages
          const stage3Threshold = isLocalNode ? 10 : 18;
          const stage3RecentCount = isLocalNode ? 8 : 14;
          if (estimated > maxPromptBudget && messages.length > stage3Threshold) {
            const recentMessages = messages.slice(-stage3RecentCount);
            let firstCleanIdx = 0;
            while (firstCleanIdx < recentMessages.length && recentMessages[firstCleanIdx].role === 'tool') {
              firstCleanIdx++;
            }
            const cleanRecent = recentMessages.slice(firstCleanIdx);
            messages = [
              messages[0],
              messages[1],
              {
                role: 'system',
                content:
                  '[系统说明：当前执行步数较多，早期的中间调用细节已归档压缩，请基于当前工作区状态与最近的执行步骤继续完成。]',
              },
              ...cleanRecent,
            ];
          }
        }

        onEvent({ type: 'step_progress', step: step + 1, maxSteps: limit });
        onEvent({ type: 'status', status: 'thinking' });
        emitContextUsage(estimateTokensFromMessages(messages), 'estimate');

        // If the model is repeatedly stuck in a tool loop, remove tools to force text conclusion
        const effectiveTools = consecutiveStuckSteps >= 2 ? undefined : tools;

        let assistant: ChatMessage;
        let callAttempts = 0;
        const maxTimeoutRetries = 1;

        while (true) {
          try {
            const result = await client.chatStreamCollect(
              {
                messages,
                tools: effectiveTools,
                signal,
              },
              (token: string) => onEvent({ type: 'token', text: token }),
              (thinking: string) => onEvent({ type: 'thinking_token', text: thinking }),
            );
            assistant = result.message;
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
                  if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 200) {
                    m.content = `${m.content.slice(0, 150)}...[因节点显存超时已紧急精简]`;
                  }
                  if (m.thinking) m.thinking = undefined;
                }
                messages = [
                  messages[0],
                  messages[1],
                  {
                    role: 'system',
                    content:
                      '[系统自愈提示：上一轮推理响应超时（>60s），已执行紧急深度上下文压缩。请直接基于当前步骤和最近工具调用结果给出下一步操作。]',
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
            args: tc.function.arguments && tc.function.arguments.trim() ? tc.function.arguments : '{}',
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
          onEvent({ type: 'done', finalText });
          return { finalText, diffs };
        }

        // Persist intermediate reasoning before tools so UI does not lose streaming text.
        // Strip bare --- separator lines which the model uses in reasoning but render as <hr> in Markdown.
        const thoughtToDisplay = (
          assistant.reasoning_content ||
          (assistant.thinking?.map((t) => t.thinking).join('\n') || '') ||
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
                  .reduce((acc, k) => {
                    acc[k] = (parsedArgs as Record<string, unknown>)[k];
                    return acc;
                  }, {} as Record<string, unknown>),
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
            toolResultContent +=
              `\n\n[系统提示]: 你刚刚已读取过完全相同的内容。严禁再次以相同参数调用 ${call.name} 工具。请直接根据已获得的数据进行思考与总结。`;
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
      onEvent({ type: 'done', finalText: '(cancelled)' });
      return { finalText: '(cancelled)', diffs };
    }
    onEvent({ type: 'error', message });
    onEvent({ type: 'status', status: 'error' });
    throw err;
  }
}
